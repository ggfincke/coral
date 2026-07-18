// src/agent/conversation-state.ts
// pure owner for stored conversation, compaction, & effect-history invariants

import {
  buildCompactedMessages,
  countFrozenPrefix,
  estimateMessageTokens,
  estimateTotalTokens,
  MAX_COMPACT_FAILURES,
  MAX_FROZEN_SUMMARIES,
  pruneToolResults as buildPrunedMessages,
  splitForCompaction,
  type CompactionConfig,
} from './compaction.js'
import {
  cloneMessages,
  cloneUndoTurn,
  isUndoTurnAligned,
  MAX_UNDO_TURNS,
  type UndoFileChange,
  type UndoTodoChange,
  type UndoTurn,
} from '../types/undo.js'
import {
  cloneAttachmentReport,
  type AttachmentReport,
} from '../types/attachments.js'
import { cloneTodoItems } from '../types/todo.js'
import type { OllamaMessage } from '../types/inference.js'

export const DEFAULT_MAX_HISTORY = 100

declare const messageAnchorBrand: unique symbol

// opaque identity for the one accepted user message owned by this state
export interface ConversationMessageAnchor
{
  readonly [messageAnchorBrand]: true
}

declare const summaryPlanBrand: unique symbol

// opaque commit token captured before an awaited summary request
export interface ConversationSummaryPlan
{
  readonly [summaryPlanBrand]: true
}

declare const replayPlanBrand: unique symbol

// opaque commit token captured before awaited file replay
export interface ConversationReplayPlan<
  Kind extends ConversationReplayKind = ConversationReplayKind,
>
{
  readonly [replayPlanBrand]: Kind
}

export type ConversationSummaryMode = 'automatic' | 'manual' | 'hard-fit'
export type ConversationReplayKind = 'undo' | 'redo'

export interface ConversationCompactionMetrics
{
  failureCount: number
  successfulCount: number
  lastCompactedAt: string | null
}

// stored-token counts deliberately exclude Agent-owned tools & request framing
export interface ConversationTransition
{
  type: 'pruned' | 'summarized' | 'trimmed'
  beforeStoredTokens: number
  afterStoredTokens: number
  beforeMessages: number
  afterMessages: number
  prunedResults?: number
}

export type PrepareConversationSummaryOptions =
  | {
      mode: 'automatic'
      config: CompactionConfig
    }
  | {
      mode: 'manual'
      config: CompactionConfig
    }
  | {
      mode: 'hard-fit'
    }

export interface PreparedConversationSummary
{
  plan: ConversationSummaryPlan
  messages: OllamaMessage[]
}

export interface ConversationFinalizeResult
{
  recorded: boolean
  warningAdded: boolean
}

export type ConversationSummaryCommit =
  | {
      status: 'committed'
      transition: ConversationTransition
    }
  | {
      status: 'stale'
    }

export type ConversationSummaryFailure =
  | {
      status: 'recorded'
      failureCount: number
      transition?: ConversationTransition
    }
  | {
      status: 'stale'
    }

export type PreparedConversationReplay<
  Kind extends ConversationReplayKind = ConversationReplayKind,
> =
  | {
      status: 'empty'
      kind: Kind
    }
  | {
      status: 'misaligned'
      kind: Kind
    }
  | {
      status: 'ready'
      kind: Kind
      plan: ConversationReplayPlan<Kind>
      turn: UndoTurn
    }

export type ConversationReplayCommit<
  Kind extends ConversationReplayKind = ConversationReplayKind,
> =
  | (Kind extends 'undo'
      ? {
          status: 'committed'
          kind: 'undo'
          removedMessages: number
        }
      : {
          status: 'committed'
          kind: 'redo'
          restoredMessages: number
        })
  | { status: 'stale' }

interface MessageAnchorRecord
{
  owner: ConversationState
  message: OllamaMessage
}

interface SummaryPlanRecord
{
  owner: ConversationState
  revision: number
  mode: ConversationSummaryMode
  frozenPrefix: OllamaMessage[]
  toKeep: OllamaMessage[]
  activeMessage?: OllamaMessage
  beforeStoredTokens: number
  beforeMessages: number
}

interface ReplayPlanRecord
{
  owner: ConversationState
  revision: number
  kind: ConversationReplayKind
  turn: UndoTurn
}

const messageAnchors = new WeakMap<
  ConversationMessageAnchor,
  MessageAnchorRecord
>()
const summaryPlans = new WeakMap<ConversationSummaryPlan, SummaryPlanRecord>()
const replayPlans = new WeakMap<ConversationReplayPlan, ReplayPlanRecord>()

function cloneUndoStack(turns: readonly UndoTurn[]): UndoTurn[]
{
  return turns.map((turn) => cloneUndoTurn(turn))
}

function cloneTodoChange(change: UndoTodoChange): UndoTodoChange
{
  return {
    before: cloneTodoItems(change.before),
    after: cloneTodoItems(change.after),
  }
}

// * Mutable conversation state w/ synchronous, revision-checked transitions.
export class ConversationState
{
  private messages: OllamaMessage[]
  private estimatedTokenCount: number
  private frozenPrefixLength = 1
  private activeAnchor?: ConversationMessageAnchor
  private compactFailureCount = 0
  private compactionCount = 0
  private lastCompactedAt: string | null = null
  private undoStack: UndoTurn[] = []
  private redoStack: UndoTurn[] = []
  private revision = 0

  constructor(system: string | OllamaMessage)
  {
    const systemMessage: OllamaMessage =
      typeof system === 'string'
        ? { role: 'system', content: system }
        : cloneMessages([system])[0]!
    if (systemMessage.role !== 'system')
    {
      throw new Error('ConversationState requires a system message')
    }

    this.messages = [systemMessage]
    this.estimatedTokenCount = estimateMessageTokens(systemMessage)
  }

  getMessages(): OllamaMessage[]
  {
    return cloneMessages(this.messages)
  }

  getEstimatedTokens(): number
  {
    return this.estimatedTokenCount
  }

  getMessageCount(): number
  {
    return this.messages.length
  }

  getFrozenPrefixLength(): number
  {
    return this.frozenPrefixLength
  }

  getFrozenPrefix(): OllamaMessage[]
  {
    return cloneMessages(this.messages.slice(0, this.frozenPrefixLength))
  }

  getCompactionMetrics(): ConversationCompactionMetrics
  {
    return {
      failureCount: this.compactFailureCount,
      successfulCount: this.compactionCount,
      lastCompactedAt: this.lastCompactedAt,
    }
  }

  getUndoStack(): UndoTurn[]
  {
    return cloneUndoStack(this.undoStack)
  }

  getRedoStack(): UndoTurn[]
  {
    return cloneUndoStack(this.redoStack)
  }

  exportUndoState(): { undo: UndoTurn[]; redo: UndoTurn[] }
  {
    return {
      undo: cloneUndoStack(this.undoStack),
      redo: cloneUndoStack(this.redoStack),
    }
  }

  getMessage(anchor: ConversationMessageAnchor): OllamaMessage | undefined
  {
    const message = this.resolveAnchor(anchor)
    return message ? cloneMessages([message])[0] : undefined
  }

  indexOf(anchor: ConversationMessageAnchor): number
  {
    const record = messageAnchors.get(anchor)
    if (record?.owner !== this) return -1
    return this.messages.indexOf(record.message)
  }

  hasActiveTurn(): boolean
  {
    return this.activeAnchor !== undefined
  }

  appendMessage(message: OllamaMessage): void
  {
    this.appendMessages([message])
  }

  appendMessages(messages: readonly OllamaMessage[]): void
  {
    if (messages.length === 0) return
    const copies = cloneMessages([...messages])
    this.messages.push(...copies)
    this.estimatedTokenCount += estimateTotalTokens(copies)
    this.touch()
  }

  replaceSystemMessage(content: string): void
  {
    const replacement: OllamaMessage = { role: 'system', content }
    const previous = this.messages[0]
    if (previous?.role === 'system')
    {
      this.messages[0] = replacement
      this.estimatedTokenCount +=
        estimateMessageTokens(replacement) - estimateMessageTokens(previous)
    }
    else
    {
      this.messages.unshift(replacement)
      this.frozenPrefixLength++
      this.rebuildTokenEstimate()
    }
    this.touch()
  }

  restoreMessages(savedMessages: readonly OllamaMessage[]): void
  {
    const currentSystem = this.messages[0]!
    const nonSystem = cloneMessages(
      savedMessages.filter((message) => message.role !== 'system')
    )
    this.messages = [currentSystem, ...nonSystem]
    this.frozenPrefixLength = countFrozenPrefix(this.messages)
    this.clearUndoRedoStacks()
    this.rebuildTokenEstimate()
    this.touch()
  }

  clearHistory(): number
  {
    const systemMessage = this.messages[0]!
    const cleared = Math.max(this.messages.length - 1, 0)
    this.messages = [systemMessage]
    this.frozenPrefixLength = 1
    this.clearUndoRedoStacks()
    this.rebuildTokenEstimate()
    this.touch()
    return cleared
  }

  resetCompactionMetrics(): void
  {
    this.compactFailureCount = 0
    this.compactionCount = 0
    this.lastCompactedAt = null
    this.touch()
  }

  restoreUndoStack(
    undoStack: readonly UndoTurn[] = [],
    redoStack: readonly UndoTurn[] = []
  ): void
  {
    this.undoStack = cloneUndoStack(undoStack).slice(-MAX_UNDO_TURNS)
    this.redoStack = cloneUndoStack(redoStack).slice(-MAX_UNDO_TURNS)
    this.touch()
  }

  acceptUserMessage(
    content: string,
    displayContent?: string
  ): ConversationMessageAnchor
  {
    if (this.activeAnchor)
    {
      throw new Error('ConversationState already has an active turn')
    }

    const message: OllamaMessage = { role: 'user', content }
    if (displayContent !== undefined) message.displayContent = displayContent
    const anchor = Object.freeze({}) as ConversationMessageAnchor
    messageAnchors.set(anchor, { owner: this, message })
    this.activeAnchor = anchor
    this.messages.push(message)
    this.estimatedTokenCount += estimateMessageTokens(message)
    this.touch()
    return anchor
  }

  commitActiveUserMessage(
    anchor: ConversationMessageAnchor,
    content: string,
    attachmentReport?: AttachmentReport
  ): boolean
  {
    const message = this.resolveActiveAnchor(anchor)
    if (!message) return false

    const before = estimateMessageTokens(message)
    message.content = content
    if (attachmentReport)
    {
      message.attachmentReport = cloneAttachmentReport(attachmentReport)
    }
    else
    {
      delete message.attachmentReport
    }
    this.estimatedTokenCount += estimateMessageTokens(message) - before
    this.touch()
    return true
  }

  finalizeActiveTurn(
    anchor: ConversationMessageAnchor,
    changes: readonly UndoFileChange[] = [],
    todoChange?: UndoTodoChange
  ): ConversationFinalizeResult
  {
    if (this.activeAnchor !== anchor)
    {
      return { recorded: false, warningAdded: false }
    }
    const message = this.resolveActiveAnchor(anchor)
    this.activeAnchor = undefined
    if (!message)
    {
      const warningAdded = this.appendMissingUndoWarning(changes)
      this.touch()
      return { recorded: false, warningAdded }
    }

    const startIndex = this.messages.indexOf(message)
    if (
      startIndex < this.frozenPrefixLength ||
      startIndex < 0 ||
      startIndex >= this.messages.length
    )
    {
      const warningAdded = this.appendMissingUndoWarning(changes)
      this.touch()
      return { recorded: false, warningAdded }
    }

    const turn: UndoTurn = {
      startIndex,
      endIndex: this.messages.length,
      userMessage: message.content,
      messages: cloneMessages(this.messages.slice(startIndex)),
      changes: changes.map((change) => ({ ...change })),
    }
    if (todoChange) turn.todoChange = cloneTodoChange(todoChange)
    this.undoStack.push(turn)
    this.undoStack = this.undoStack.slice(-MAX_UNDO_TURNS)
    this.redoStack = []
    this.touch()
    return { recorded: true, warningAdded: false }
  }

  prepareSummary(
    options: PrepareConversationSummaryOptions
  ): PreparedConversationSummary | null
  {
    let frozenPrefix: OllamaMessage[]
    let toSummarize: OllamaMessage[]
    let toKeep: OllamaMessage[]

    if (options.mode === 'hard-fit')
    {
      if (!this.activeAnchor) return null
      const activeMessage = this.resolveAnchor(this.activeAnchor)
      if (!activeMessage) return null
      const activeIndex = this.messages.indexOf(activeMessage)
      if (activeIndex <= 1) return null
      frozenPrefix = [this.messages[0]!]
      toSummarize = this.messages.slice(1, activeIndex)
      toKeep = this.messages.slice(activeIndex)
    }
    else if (options.mode === 'manual')
    {
      if (this.messages.length < 4) return null
      const relaxedConfig: CompactionConfig = {
        ...options.config,
        minMessagesForCompaction: 4,
        minRecentMessages: Math.min(
          options.config.minRecentMessages,
          Math.max(Math.floor((this.messages.length - 1) / 2), 2)
        ),
      }
      ;({ toSummarize, toKeep } = splitForCompaction(
        this.messages,
        relaxedConfig,
        1
      ))
      frozenPrefix = [this.messages[0]!]
    }
    else
    {
      const consolidate = this.frozenPrefixLength - 1 >= MAX_FROZEN_SUMMARIES
      const splitFrom = consolidate ? 1 : this.frozenPrefixLength
      ;({ toSummarize, toKeep } = splitForCompaction(
        this.messages,
        options.config,
        splitFrom
      ))
      const activeMessage = this.activeAnchor
        ? this.resolveAnchor(this.activeAnchor)
        : undefined
      const activeIndex = activeMessage
        ? this.messages.indexOf(activeMessage)
        : -1
      if (
        activeMessage &&
        activeIndex >= splitFrom &&
        toSummarize.includes(activeMessage)
      )
      {
        toSummarize = this.messages.slice(splitFrom, activeIndex)
        toKeep = this.messages.slice(activeIndex)
      }
      frozenPrefix = this.messages.slice(0, splitFrom)
    }

    if (toSummarize.length === 0) return null

    const plan = Object.freeze({}) as ConversationSummaryPlan
    summaryPlans.set(plan, {
      owner: this,
      revision: this.revision,
      mode: options.mode,
      frozenPrefix,
      toKeep,
      activeMessage: this.activeAnchor
        ? this.resolveAnchor(this.activeAnchor)
        : undefined,
      beforeStoredTokens: this.estimatedTokenCount,
      beforeMessages: this.messages.length,
    })
    return { plan, messages: cloneMessages(toSummarize) }
  }

  commitSummary(
    plan: ConversationSummaryPlan,
    summary: string,
    compactedAt: string
  ): ConversationSummaryCommit
  {
    if (!summary.trim())
    {
      throw new Error('Conversation summary cannot be empty')
    }

    const record = this.consumeCurrentSummaryPlan(plan)
    if (!record) return { status: 'stale' }

    this.messages = buildCompactedMessages(
      record.frozenPrefix,
      summary,
      record.toKeep
    )
    this.frozenPrefixLength = record.frozenPrefix.length + 1
    this.clearUndoRedoStacks()
    if (record.mode !== 'manual') this.compactFailureCount = 0
    this.rebuildTokenEstimate()
    this.recordSuccessfulCompaction(compactedAt)
    this.touch()

    return {
      status: 'committed',
      transition: this.makeTransition(
        'summarized',
        record.beforeStoredTokens,
        record.beforeMessages
      ),
    }
  }

  recordAutomaticSummaryFailure(
    plan: ConversationSummaryPlan,
    maxHistory = DEFAULT_MAX_HISTORY
  ): ConversationSummaryFailure
  {
    const record = this.consumeCurrentSummaryPlan(plan)
    if (!record) return { status: 'stale' }
    if (record.mode !== 'automatic')
    {
      throw new Error('Only automatic summaries record compaction failures')
    }

    this.compactFailureCount++
    if (this.compactFailureCount < MAX_COMPACT_FAILURES)
    {
      this.touch()
      return {
        status: 'recorded',
        failureCount: this.compactFailureCount,
      }
    }

    this.trimInternal(maxHistory, record.activeMessage)
    this.compactFailureCount = 0
    this.touch()
    const transition = this.makeTransition(
      'trimmed',
      record.beforeStoredTokens,
      record.beforeMessages
    )
    return {
      status: 'recorded',
      failureCount: 0,
      ...(transition.beforeMessages === transition.afterMessages
        ? {}
        : { transition }),
    }
  }

  pruneToolResults(
    compactedAt: string,
    protectCount?: number
  ): ConversationTransition | null
  {
    const beforeStoredTokens = this.estimatedTokenCount
    const beforeMessages = this.messages.length
    const { prunedMessages, prunedCount } = buildPrunedMessages(
      this.messages,
      protectCount,
      this.frozenPrefixLength
    )
    if (prunedCount === 0) return null

    this.messages = prunedMessages
    this.rebuildTokenEstimate()
    this.recordSuccessfulCompaction(compactedAt)
    this.touch()
    return {
      ...this.makeTransition('pruned', beforeStoredTokens, beforeMessages),
      prunedResults: prunedCount,
    }
  }

  trimToMax(maxHistory = DEFAULT_MAX_HISTORY): ConversationTransition
  {
    const beforeStoredTokens = this.estimatedTokenCount
    const beforeMessages = this.messages.length
    const activeMessage = this.activeAnchor
      ? this.resolveAnchor(this.activeAnchor)
      : undefined
    this.trimInternal(maxHistory, activeMessage)
    this.touch()
    return this.makeTransition('trimmed', beforeStoredTokens, beforeMessages)
  }

  prepareUndo(): PreparedConversationReplay<'undo'>
  {
    const turn = this.undoStack.at(-1)
    if (!turn) return { status: 'empty', kind: 'undo' }
    if (
      !isUndoTurnAligned(this.messages, turn, {
        requireLiveTail: true,
        frozenPrefixLength: this.frozenPrefixLength,
      })
    )
    {
      this.clearUndoRedoStacks()
      this.touch()
      return { status: 'misaligned', kind: 'undo' }
    }
    return this.prepareReplay('undo', turn)
  }

  prepareRedo(): PreparedConversationReplay<'redo'>
  {
    const turn = this.redoStack.at(-1)
    if (!turn) return { status: 'empty', kind: 'redo' }
    if (
      turn.startIndex !== this.messages.length ||
      turn.startIndex < this.frozenPrefixLength
    )
    {
      this.clearUndoRedoStacks()
      this.touch()
      return { status: 'misaligned', kind: 'redo' }
    }
    return this.prepareReplay('redo', turn)
  }

  commitReplay<Kind extends ConversationReplayKind>(
    plan: ConversationReplayPlan<Kind>
  ): ConversationReplayCommit<Kind>
  {
    const record = replayPlans.get(plan)
    if (record?.owner !== this) return { status: 'stale' }
    replayPlans.delete(plan)
    if (record.revision !== this.revision)
    {
      return { status: 'stale' }
    }

    if (record.kind === 'undo')
    {
      if (this.undoStack.at(-1) !== record.turn) return { status: 'stale' }
      const removedMessages = this.messages.length - record.turn.startIndex
      this.messages = this.messages.slice(0, record.turn.startIndex)
      const undone = this.undoStack.pop()!
      const redo = cloneUndoTurn(undone)
      redo.startIndex = this.messages.length
      redo.endIndex = this.messages.length + redo.messages.length
      this.redoStack.push(redo)
      this.redoStack = this.redoStack.slice(-MAX_UNDO_TURNS)
      this.rebuildTokenEstimate()
      this.touch()
      return {
        status: 'committed',
        kind: 'undo',
        removedMessages,
      } as ConversationReplayCommit<Kind>
    }

    if (this.redoStack.at(-1) !== record.turn) return { status: 'stale' }
    const startIndex = this.messages.length
    const restored = cloneMessages(record.turn.messages)
    this.messages.push(...restored)
    this.redoStack.pop()
    const undo = cloneUndoTurn(record.turn)
    undo.startIndex = startIndex
    undo.endIndex = this.messages.length
    this.undoStack.push(undo)
    this.undoStack = this.undoStack.slice(-MAX_UNDO_TURNS)
    this.rebuildTokenEstimate()
    this.touch()
    return {
      status: 'committed',
      kind: 'redo',
      restoredMessages: restored.length,
    } as ConversationReplayCommit<Kind>
  }

  private prepareReplay<Kind extends ConversationReplayKind>(
    kind: Kind,
    turn: UndoTurn
  ): PreparedConversationReplay<Kind>
  {
    const plan = Object.freeze({}) as ConversationReplayPlan<Kind>
    replayPlans.set(plan, {
      owner: this,
      revision: this.revision,
      kind,
      turn,
    })
    return {
      status: 'ready',
      kind,
      plan,
      turn: cloneUndoTurn(turn),
    }
  }

  private resolveAnchor(
    anchor: ConversationMessageAnchor
  ): OllamaMessage | undefined
  {
    const record = messageAnchors.get(anchor)
    if (record?.owner !== this) return undefined
    return this.messages.includes(record.message) ? record.message : undefined
  }

  private resolveActiveAnchor(
    anchor: ConversationMessageAnchor
  ): OllamaMessage | undefined
  {
    if (this.activeAnchor !== anchor) return undefined
    return this.resolveAnchor(anchor)
  }

  private consumeCurrentSummaryPlan(
    plan: ConversationSummaryPlan
  ): SummaryPlanRecord | undefined
  {
    const record = summaryPlans.get(plan)
    if (record?.owner !== this) return undefined
    summaryPlans.delete(plan)
    if (record.revision !== this.revision)
    {
      return undefined
    }
    return record
  }

  private trimInternal(maxHistory: number, preserve?: OllamaMessage): void
  {
    if (!Number.isInteger(maxHistory) || maxHistory < 0)
    {
      throw new RangeError('maxHistory must be a non-negative integer')
    }

    const frozen = this.messages.slice(0, this.frozenPrefixLength)
    const liveBudget = Math.max(maxHistory - this.frozenPrefixLength, 0)
    let recent =
      liveBudget === 0
        ? []
        : this.messages.slice(this.frozenPrefixLength).slice(-liveBudget)

    if (preserve)
    {
      const preserveIndex = this.messages.indexOf(preserve)
      if (
        preserveIndex >= this.frozenPrefixLength &&
        !recent.includes(preserve)
      )
      {
        recent = this.messages.slice(preserveIndex)
      }
    }

    this.messages = [...frozen, ...recent]
    this.clearUndoRedoStacks()
    this.rebuildTokenEstimate()
  }

  private makeTransition(
    type: ConversationTransition['type'],
    beforeStoredTokens: number,
    beforeMessages: number
  ): ConversationTransition
  {
    return {
      type,
      beforeStoredTokens,
      afterStoredTokens: this.estimatedTokenCount,
      beforeMessages,
      afterMessages: this.messages.length,
    }
  }

  private clearUndoRedoStacks(): void
  {
    this.undoStack = []
    this.redoStack = []
  }

  private appendMissingUndoWarning(
    changes: readonly UndoFileChange[]
  ): boolean
  {
    if (changes.length === 0) return false
    const warning: OllamaMessage = {
      role: 'system',
      content:
        "Warning: undo could not record this turn's file changes after history trim",
    }
    this.messages.push(warning)
    this.estimatedTokenCount += estimateMessageTokens(warning)
    return true
  }

  private rebuildTokenEstimate(): void
  {
    this.estimatedTokenCount = estimateTotalTokens(this.messages)
  }

  private recordSuccessfulCompaction(compactedAt: string): void
  {
    this.compactionCount++
    this.lastCompactedAt = compactedAt
  }

  private touch(): void
  {
    this.revision++
  }
}
