// src/agent/agent.ts
// conversation loop w/ tool-use cycling

import { OllamaClient } from '../ollama/client.js'
import type { AgentInferenceClient } from './inference-client.js'
import {
  makeReliabilityStats,
  type ModelRequestMessage,
  type OllamaMessage,
  type OllamaToolCall,
  type ReliabilityStats,
} from '../types/inference.js'
import {
  allTools,
  subagentTools,
  ToolCatalog,
  type Tool,
  type ToolCallPresentation,
  type ToolExecutionContext,
  type ToolResult,
} from '../tools/index.js'
import { type SubagentResult, type SubagentRunner } from '../tools/subagent.js'
import { DEFAULT_OLLAMA_HOST } from '../ollama/host.js'
import { buildSystemPrompt } from './system-prompt.js'
import { projectContextBudgetForWindow } from './context.js'
import { setCwd, getCwd } from '../cwd.js'
import { resolve } from 'node:path'
import {
  resolvePermissions,
  getToolPolicy,
  type ToolPermissions,
} from '../config/permissions.js'
import {
  estimateMessageTokens,
  shouldPrune,
  shouldCompactByTotal,
  buildCompactionPrompt,
  stripThinkingForCompaction,
  type CompactionConfig,
  type CompactionResult,
  DEFAULT_COMPACTION_CONFIG,
} from './compaction.js'
import {
  ConversationState,
  DEFAULT_MAX_HISTORY,
  type ConversationMessageAnchor,
  type ConversationTransition,
} from './conversation-state.js'
import { MIN_NUM_CTX, resolvePinnedContextWindow } from '../config/context.js'
import { totalmem } from 'node:os'

export type { CompactionResult } from './compaction.js'
export type { AgentInferenceClient } from './inference-client.js'
export type { TurnInput } from './turn-context.js'
import { toError, toErrorMessage } from '../utils/errors.js'
import { raceAbort } from '../utils/abort.js'
import { normalizeToolName } from '../utils/tool-name.js'
import { capErrorMessage } from '../tools/tool-output.js'
import {
  trimLeadingLowSurrogate,
  trimTrailingHighSurrogate,
} from '../utils/ellipsize.js'
import {
  parseToolCallsFromContent,
  STALL_NUDGE_MESSAGE,
  MAX_STALL_NUDGES,
  looksLikeAttemptedToolCall,
  REPROMPT_MESSAGE,
  MAX_REPROMPTS,
} from './repair.js'
import {
  DoomLoopDetector,
  describeDoomLoop,
  type DoomLoopTrip,
} from './doom-loop.js'
import {
  buildVerifyPrompt,
  buildVerifyReprompt,
  parseVerifyVerdict,
  MAX_VERIFY_REPROMPTS,
  type VerificationResult,
} from './verify.js'
import type {
  UndoFileChange,
  UndoResult,
  UndoTodoChange,
  UndoTurn,
} from '../types/undo.js'
import {
  cloneTodoItems,
  type TodoItem,
  type TodoListener,
  type TodoState,
} from '../types/todo.js'
import { applyFileChanges, revertFileChanges } from './undo.js'
import { validateToolArgs } from './tool-validation.js'
import { resolveVerifyConfig } from '../config/verify.js'
import {
  appendAttachmentContext,
  attachmentReportFromMaterialization,
  type AttachmentMaterialization,
} from './attachments.js'
import {
  TurnContextAssembler,
  type CapturedTurn,
  type TurnContextDependencies,
  type TurnInput,
} from './turn-context.js'
import { requiresWorkspacePathApproval } from '../tools/path-policy.js'
import { TypeScriptCodeIntel, type CodeIntelService } from '../lsp/client.js'
import { AgentTodoState } from './todo-state.js'
import {
  configuredMcpStatus,
  type McpLaunchApprovalRequest,
  type McpStatus,
} from '../mcp/types.js'
import { resolveMcpConfig, type McpConfigResolution } from '../config/mcp.js'
import {
  assertRequestBudget,
  attachmentAllowanceForFixedCost,
  createRequestBudgetBreakdown,
  estimateModelRequestMessageDeltaTokens,
  estimateModelRequestMessageTokens,
  estimateModelRequestMessagesTokens,
  estimateModelRequestToolTokens,
  estimateRequestFramingTokens,
  requestBudgetCapacity,
  toModelRequestMessage,
  type RequestBudgetBreakdown,
} from './request-budget.js'
import {
  CHARS_PER_TOKEN,
  MAX_TOOL_OUTPUT_CHARS,
  estimateUtf8Tokens,
} from '../utils/limits.js'

// cap tool-call rounds for a research subagent so it can't loop unbounded
const SUBAGENT_MAX_ITERATIONS = 24

// model-emitted tool arguments are protocol history after execution; bound a
// pathological payload so its echo cannot crowd out the corresponding result
const MAX_STORED_TOOL_ARGUMENT_TOKENS = 2_048

const COMPACTION_SYSTEM_PROMPT =
  'You are a helpful assistant. Produce a concise structured summary of the conversation.'

const TOOL_RESULT_OMITTED = '[tool result omitted to fit request budget]'
const TOOL_RESULT_REDACTED_OMITTED =
  '[tool result omitted to fit request budget; redacted content was present]'

function mergeReliabilityStats(
  base: ReliabilityStats | undefined,
  add: ReliabilityStats
): ReliabilityStats
{
  const merged = makeReliabilityStats()
  for (const key of Object.keys(merged) as (keyof ReliabilityStats)[])
  {
    merged[key] = (base?.[key] ?? 0) + add[key]
  }
  return merged
}

function toolError(error: string): ToolResult
{
  return { output: '', error }
}

interface ToolInvocation
{
  id: number
  name: string
  args: Record<string, unknown>
}

interface ToolOutcomeRecordParams
{
  events: AgentEvents
  toolResults: OllamaMessage[]
  roundBudget: ToolResultRoundBudget
  doomLoop: DoomLoopDetector
  editDiffs: string[]
  fileChanges: UndoFileChange[]
  todoChange: TodoChangeTracker
  invocation: ToolInvocation
  result: ToolResult
  trackDoom?: boolean
}

interface ToolResultRoundBudget
{
  minimumTokens: readonly number[]
  nextResult: number
  remainingCalls: number
  remainingMinimumTokens: number
  remainingTokens: number
}

interface TodoChangeTracker
{
  before: TodoItem[] | null
  after: TodoItem[] | null
}

// merge streamed tool call chunks into a stable ordered list
function mergeToolCalls(
  existing: OllamaToolCall[],
  incoming: OllamaToolCall[]
): OllamaToolCall[]
{
  const merged = [...existing]

  for (const call of incoming)
  {
    const index = call.function.index

    if (typeof index === 'number')
    {
      const existingIndex = merged.findIndex(
        (candidate) => candidate.function.index === index
      )

      if (existingIndex === -1)
      {
        merged.push(call)
      }
      else
      {
        merged[existingIndex] = call
      }

      continue
    }

    merged.push(call)
  }

  return merged.sort((a, b) =>
  {
    const left = a.function.index
    const right = b.function.index

    if (typeof left === 'number' && typeof right === 'number')
    {
      return left - right
    }
    if (typeof left === 'number') return -1
    if (typeof right === 'number') return 1
    return 0
  })
}

function storedToolCall(call: OllamaToolCall): OllamaToolCall
{
  const serialized = JSON.stringify(call.function.arguments)
  if (
    estimateUtf8Tokens(serialized).tokens <= MAX_STORED_TOOL_ARGUMENT_TOKENS
  )
  {
    return call
  }

  return {
    type: call.type,
    function: {
      index: call.function.index,
      name: call.function.name,
      arguments: {
        _coral_notice:
          'tool arguments omitted from history after execution to fit context',
        keys: Object.keys(call.function.arguments),
      },
    },
  }
}

function finalizedTodoChange(
  change: TodoChangeTracker
): UndoTodoChange | undefined
{
  if (!change.before || !change.after) return undefined
  return {
    before: cloneTodoItems(change.before),
    after: cloneTodoItems(change.after),
  }
}

// token usage from Ollama's response metrics
// durations are nanoseconds — Ollama's native unit from prompt_eval_duration / eval_duration
export interface TokenUsage
{
  promptTokens: number
  completionTokens: number
  totalPromptTokens: number
  totalCompletionTokens: number
  // current context occupancy (chars/4 of the live message array) — the value
  // compaction triggers on, unlike the cumulative totals above
  contextTokens: number
  // last turn — undefined when the server omitted the field
  promptEvalDurationNs?: number
  evalDurationNs?: number
  // cumulative across the whole session
  totalPromptEvalDurationNs: number
  totalEvalDurationNs: number
}

// callbacks for streaming tokens, tool calls, & completion
export interface AgentEvents
{
  onToken: (token: string) => void
  onThinking?: (thinking: string) => void
  // callId correlates a result back to its call — required for parallel batches
  // where several calls (often same-named) are announced before any resolve
  onToolCall: (
    name: string,
    args: Record<string, unknown>,
    callId: number,
    presentation?: ToolCallPresentation
  ) => void
  onToolResult: (
    name: string,
    result: string,
    error: string | undefined,
    callId: number,
    diff?: string
  ) => void
  // return true to approve, false to reject — only called for write/edit/bash
  onToolApproval: (
    name: string,
    args: Record<string, unknown>,
    presentation?: ToolCallPresentation
  ) => Promise<boolean>
  // launch trust is separate from per-tool approval & never auto-approved
  onMcpLaunchApproval?: (request: McpLaunchApprovalRequest) => Promise<boolean>
  // a stuck loop was detected — return true to continue, false to stop the run
  onDoomLoop?: (message: string) => Promise<boolean>
  // result of the post-edit self-check (warn-only — does not alter history)
  onVerification?: (result: VerificationResult) => void
  onUsage?: (usage: TokenUsage) => void
  // reports the one atomic attachment materialization for transcript notices
  onAttachments?: (result: AttachmentMaterialization) => void
  // fires before a summarization model call starts (so the TUI can show status)
  onCompactionStart?: () => void
  // fires after a prune or summarize completes w/ stats
  onCompaction?: (result: CompactionResult) => void
  onDone: () => void
  onError: (error: Error) => void
}

export interface AgentMcpManager
{
  initialize(options: {
    signal?: AbortSignal
    onLaunchApproval?: (request: McpLaunchApprovalRequest) => Promise<boolean>
  }): Promise<Tool[]>
  getStatus(): McpStatus
  dispose(): Promise<void>
}

export interface AgentOptions
{
  think?: boolean | 'low' | 'medium' | 'high'
  // restrict tools; subagents get a safe subset
  tools?: readonly Tool[]
  // cap tool-call rounds (bounds subagent cost); undefined = unlimited
  maxIterations?: number
  // pinned num_ctx inherited from a parent agent — subagents must use the same
  // value so they don't trigger an Ollama runner reload that wipes the KV cache
  numCtx?: number
  // run a read-only self-check subagent after edit-producing turns; defaults to
  // the .coral.json verify.enabled flag. subagents pass false (they can't edit)
  verifyEdits?: boolean
  // override local/user tool policy; eval harnesses need reproducible defaults
  permissions?: ToolPermissions
  // share the interactive Agent's lazy LSP client w/ read-only subagents
  codeIntel?: CodeIntelService
  // only the primary interactive Agent opts into user-configured MCP servers
  mcp?: boolean
  // pin one MCP config snapshot across primary Agent replacements & mode changes
  mcpConfig?: McpConfigResolution
  // inject restored session state before the Agent becomes observable
  todoState?: TodoState
  // deterministic context I/O seam for the framework-neutral turn assembler
  turnContext?: TurnContextDependencies
  // narrow transport seam; production keeps the Ollama client as the default
  inferenceClient?: AgentInferenceClient
  // one runner powers both the task tool & post-edit verification
  readOnlySubagentRunner?: SubagentRunner
  // preserve lazy MCP SDK loading while allowing causal manager test doubles
  mcpManagerFactory?: () => Promise<AgentMcpManager>
}

// opaque admission receipt used to join the already-recorded turn to its run
export interface AcceptedTurn
{
  readonly id: symbol
  readonly input: TurnInput
}

interface ActiveAcceptedTurn
{
  handle: AcceptedTurn
  anchor: ConversationMessageAnchor
  running: boolean
}

interface PreparedAttachmentRequest
{
  materialization: AttachmentMaterialization
  content: string
  messages: ModelRequestMessage[]
  budget: RequestBudgetBreakdown
}

// * Conversation agent w/ tool dispatch
export class Agent
{
  private client: AgentInferenceClient
  private state!: ConversationState
  private model: string
  private baseUrl?: string
  private cwd: string
  private permissions: ToolPermissions
  private compactionConfig: CompactionConfig
  private thinkMode: boolean | 'low' | 'medium' | 'high'
  // per-instance toolset & its Ollama format — subagents run a restricted subset
  private baseTools: readonly Tool[]
  private mcpTools: readonly Tool[] = []
  // one immutable profile derives active lookup, schemas, names, & token cost
  private toolCatalog!: ToolCatalog
  private maxIterations?: number
  // pinned context window sent as options.num_ctx — held constant per session so
  // Ollama never reloads the runner & busts the KV cache (0 = not yet resolved)
  private numCtx = 0
  // in-flight context-window resolution — dedups concurrent callers (the TUI &
  // run()) onto a single /api/show; cleared on settle so failures can retry
  private contextWindowPromise?: Promise<number>
  private contextResolutionAbort?: AbortController
  private totalPromptTokens = 0
  private totalCompletionTokens = 0
  // cumulative nanoseconds of model time across the session
  private totalPromptEvalDurationNs = 0
  private totalEvalDurationNs = 0
  private contextWindowSize = 0
  private lastRequestBudget?: RequestBudgetBreakdown
  private reliabilityStats: ReliabilityStats = makeReliabilityStats()
  private telemetryStatsByModel = new Map<string, ReliabilityStats>()
  private producedModels = new Set<string>()
  private readonly todoState: TodoState
  private readonly turnContext: TurnContextAssembler
  private acceptedTurn?: ActiveAcceptedTurn
  private onCompactionCallback?: (result: CompactionResult) => void
  private onCompactionStartCallback?: () => void
  // self-check edits after a clean completion (warn-only); off by default
  private verifyEdits: boolean
  private subagentRunner: SubagentRunner
  private codeIntel: CodeIntelService
  private ownsCodeIntel: boolean
  private mcpConfig?: McpConfigResolution
  private mcpEnabled = false
  private mcpManager?: AgentMcpManager
  private installedMcpManager?: AgentMcpManager
  private readonly mcpManagerFactory?: () => Promise<AgentMcpManager>
  private readonly lifecycleAbort = new AbortController()
  private readonly activeRuns = new Set<Promise<void>>()
  private mcpBootstrapPromise?: Promise<void>
  private readonly mcpRetirements = new Set<Promise<void>>()
  private disposePromise?: Promise<void>

  constructor(
    model: string,
    baseUrl?: string,
    cwd?: string,
    options: AgentOptions = {}
  )
  {
    this.model = model
    this.baseUrl = baseUrl
    this.cwd = resolve(cwd ?? getCwd())
    this.client = options.inferenceClient ?? new OllamaClient(baseUrl)
    this.thinkMode = options.think ?? true
    this.baseTools = options.tools ?? allTools
    this.wireToolCatalog()
    this.maxIterations = options.maxIterations
    this.verifyEdits =
      options.verifyEdits ?? resolveVerifyConfig(this.cwd).enabled
    this.codeIntel = options.codeIntel ?? new TypeScriptCodeIntel(this.cwd)
    this.ownsCodeIntel = options.codeIntel === undefined
    this.todoState = options.todoState ?? new AgentTodoState()
    this.turnContext = new TurnContextAssembler(this.cwd, options.turnContext)

    // keep the interactive default in sync w/ explicitly selected sessions
    if (cwd) setCwd(this.cwd)

    // load per-tool permission policies from config unless a caller injects one
    this.permissions = options.permissions ?? resolvePermissions(this.cwd)
    this.mcpConfig = options.mcpConfig
    this.mcpManagerFactory = options.mcpManagerFactory
    // manager construction is deferred to run bootstrap so no-MCP sessions &
    // informational CLI exits never load the SDK dependency graph
    this.mcpEnabled = Boolean(options.mcp)

    // compaction defaults — can be overridden via setCompactionConfig()
    this.compactionConfig = { ...DEFAULT_COMPACTION_CONFIG }

    // inherit a parent's pinned context window (subagents) so all requests to
    // the shared model use the same num_ctx & the KV cache survives
    if (options.numCtx && options.numCtx > 0)
    {
      this.numCtx = options.numCtx
      this.contextWindowSize = options.numCtx
      this.compactionConfig.contextWindow = requestBudgetCapacity(
        options.numCtx
      ).promptLimit
    }

    // inject system prompt as first message
    const systemContent = this.buildSystemContent(model)
    this.state = new ConversationState(systemContent)

    this.subagentRunner =
      options.readOnlySubagentRunner ??
      ((prompt, signal) => this.runReadOnlySubagent(prompt, signal))

    // keep client model tracking in sync w/ model-specific chat requests
    this.client.startKeepAlive(model)
  }

  // create one read-only child w/ borrowed integration resources
  private createReadOnlySubagent(): Agent
  {
    return new Agent(this.model, this.baseUrl, this.cwd, {
      think: this.thinkMode,
      tools: subagentTools,
      maxIterations: SUBAGENT_MAX_ITERATIONS,
      numCtx: this.numCtx,
      verifyEdits: false,
      codeIntel: this.codeIntel,
      mcp: false,
    })
  }

  // run a bounded read-only subagent & always close its local scope
  private async runReadOnlySubagent(
    prompt: string,
    signal?: AbortSignal
  ): Promise<SubagentResult>
  {
    const sub = this.createReadOnlySubagent()

    let text = ''
    let error: string | undefined
    try
    {
      await sub.run(
        prompt,
        {
          onToken: (token) =>
          {
            text += token
          },
          onToolCall: () =>
          {},
          onToolResult: () =>
          {},
          // subagent tools are safe, but config can still gate them; deny anything
          // unexpected that would otherwise need approval
          onToolApproval: async () => false,
          onDone: () =>
          {},
          onError: (err) =>
          {
            error = err.message
          },
        },
        signal
      )

      return {
        text: text.trim(),
        error,
        aborted: signal?.aborted === true,
      }
    }
    finally
    {
      await sub.dispose()
    }
  }

  // self-check edits w/ a fresh read-only subagent that reviews the diffs
  // against the original request. warn-only — returns a verdict, never edits
  // history. borrows the parent's model/LSP. null on abort/failure
  private async runEditVerification(
    request: string,
    diffs: string[],
    signal?: AbortSignal
  ): Promise<VerificationResult | null>
  {
    const result = await this.subagentRunner(
      buildVerifyPrompt(request, diffs),
      signal
    )

    if (result.error || result.aborted) return null
    return parseVerifyVerdict(result.text, diffs.length)
  }

  // abort active work & close Agent-local resources — idempotent; host-global
  // model eviction is an explicit composition policy, never part of disposal
  dispose(): Promise<void>
  {
    if (!this.disposePromise)
    {
      // abort every pending bootstrap before joining cleanup
      this.lifecycleAbort.abort()
      this.contextResolutionAbort?.abort()
      this.mcpEnabled = false
      this.disposePromise = this.disposeInternal()
    }
    return this.disposePromise
  }

  private async disposeInternal(): Promise<void>
  {
    await Promise.allSettled([
      ...this.activeRuns,
      ...(this.contextWindowPromise ? [this.contextWindowPromise] : []),
    ])

    try
    {
      await this.mcpBootstrapPromise?.catch(() => undefined)
      await Promise.allSettled([...this.mcpRetirements])
      await this.mcpManager?.dispose()
    }
    finally
    {
      if (this.ownsCodeIntel) await this.codeIntel.dispose()
    }
  }

  getMcpStatus(): McpStatus
  {
    if (this.mcpManager) return this.mcpManager.getStatus()
    this.mcpConfig ??= resolveMcpConfig()
    return configuredMcpStatus(this.mcpConfig)
  }

  private async createMcpManager(): Promise<AgentMcpManager>
  {
    if (this.mcpManagerFactory) return this.mcpManagerFactory()
    this.mcpConfig ??= resolveMcpConfig()
    const { McpManager } = await import('../mcp/manager.js')
    return new McpManager({
      config: this.mcpConfig,
      permissions: this.permissions,
      baseTools: this.baseTools,
      maxDynamicToolTokens: this.dynamicToolTokenBudget(),
    })
  }

  private dynamicToolTokenBudget(): number
  {
    const promptLimit = requestBudgetCapacity(
      this.contextWindowSize || MIN_NUM_CTX
    ).promptLimit
    const totalToolBudget = Math.floor(promptLimit * 0.5)
    return Math.max(
      totalToolBudget - this.toolCatalog.trustedDefinitionTokens,
      0
    )
  }

  isMcpEnabled(): boolean
  {
    return this.mcpEnabled
  }

  async setMcpEnabled(enabled: boolean, signal?: AbortSignal): Promise<void>
  {
    signal?.throwIfAborted()
    this.lifecycleAbort.signal.throwIfAborted()
    this.mcpEnabled = enabled
    // a fresh manager is created lazily at the next run bootstrap
    if (enabled) return

    const manager = this.mcpManager
    this.mcpManager = undefined
    this.installedMcpManager = undefined
    this.mcpTools = []
    this.refreshTools()
    await this.retireMcpManager(manager)
  }

  private retireMcpManager(manager?: AgentMcpManager): Promise<void>
  {
    if (!manager) return Promise.resolve()
    const retirement = manager.dispose()
    this.mcpRetirements.add(retirement)
    const untrack = () => this.mcpRetirements.delete(retirement)
    retirement.then(untrack, untrack)
    return retirement
  }

  // retire a bootstrap snapshot that never became an installed capability set
  private retireUninstalledMcpManager(manager: AgentMcpManager): Promise<void>
  {
    if (this.mcpManager !== manager || this.installedMcpManager === manager)
    {
      return Promise.resolve()
    }

    this.mcpManager = undefined
    this.installedMcpManager = undefined
    return this.retireMcpManager(manager)
  }

  // restore conversation from a previous session's messages
  // replaces the current history (keeps system prompt at index 0)
  restoreMessages(savedMessages: OllamaMessage[]): void
  {
    this.state.restoreMessages(savedMessages)
  }

  // get a snapshot of the current message history (for session persistence)
  getMessages(): OllamaMessage[]
  {
    return this.state.getMessages()
  }

  getTodos(): TodoItem[]
  {
    return this.todoState.snapshot()
  }

  clearTodos(): void
  {
    this.todoState.clear()
  }

  subscribeTodos(listener: TodoListener): () => void
  {
    return this.todoState.subscribe(listener)
  }

  // restore undo records from a saved session; invalid records are ignored by
  // the session parser before this point
  restoreUndoStack(
    undoStack: UndoTurn[] = [],
    redoStack: UndoTurn[] = []
  ): void
  {
    this.state.restoreUndoStack(undoStack, redoStack)
  }

  getUndoStack(): UndoTurn[]
  {
    return this.state.getUndoStack()
  }

  getRedoStack(): UndoTurn[]
  {
    return this.state.getRedoStack()
  }

  // hand stacks to serialize w/ one clone boundary (avoid getUndo/getRedo double-clone)
  exportUndoStateForPersistence(): { undo: UndoTurn[]; redo: UndoTurn[] }
  {
    return this.state.exportUndoState()
  }

  async undoLastTurn(signal?: AbortSignal): Promise<UndoResult>
  {
    signal?.throwIfAborted()
    const prepared = this.state.prepareUndo()
    if (prepared.status === 'empty')
    {
      return { ok: false, message: 'Nothing to undo' }
    }
    if (prepared.status === 'misaligned')
    {
      return {
        ok: false,
        message: 'Cannot undo after compaction or history changes',
      }
    }
    const turn = prepared.turn

    const reverted = await revertFileChanges(turn.changes, {
      cwd: this.cwd,
      signal,
    })
    if (!reverted.ok)
    {
      return { ok: false, message: reverted.error }
    }

    if (turn.todoChange) this.todoState.replace(turn.todoChange.before)
    const committed = this.state.commitReplay(prepared.plan)
    if (committed.status === 'stale')
    {
      if (turn.todoChange) this.todoState.replace(turn.todoChange.after)
      const rollback = await applyFileChanges(turn.changes, { cwd: this.cwd })
      return {
        ok: false,
        message: rollback.ok
          ? 'Cannot undo after concurrent history changes'
          : `Cannot undo after concurrent history changes; rollback failed: ${rollback.error}`,
      }
    }

    return {
      ok: true,
      message: 'Undid last turn',
      removedMessages: committed.removedMessages,
      changedFiles: reverted.changedFiles,
    }
  }

  async redoLastTurn(signal?: AbortSignal): Promise<UndoResult>
  {
    signal?.throwIfAborted()
    const prepared = this.state.prepareRedo()
    if (prepared.status === 'empty')
    {
      return { ok: false, message: 'Nothing to redo' }
    }
    if (prepared.status === 'misaligned')
    {
      return {
        ok: false,
        message: 'Cannot redo after compaction or history changes',
      }
    }
    const turn = prepared.turn

    const applied = await applyFileChanges(turn.changes, {
      cwd: this.cwd,
      signal,
    })
    if (!applied.ok)
    {
      return { ok: false, message: applied.error }
    }

    if (turn.todoChange) this.todoState.replace(turn.todoChange.after)
    const committed = this.state.commitReplay(prepared.plan)
    if (committed.status === 'stale')
    {
      if (turn.todoChange) this.todoState.replace(turn.todoChange.before)
      const rollback = await revertFileChanges(turn.changes, { cwd: this.cwd })
      return {
        ok: false,
        message: rollback.ok
          ? 'Cannot redo after concurrent history changes'
          : `Cannot redo after concurrent history changes; rollback failed: ${rollback.error}`,
      }
    }

    return {
      ok: true,
      message: 'Redid last turn',
      restoredMessages: committed.restoredMessages,
      changedFiles: applied.changedFiles,
    }
  }

  // get the model name
  getModel(): string
  {
    return this.model
  }

  getCwd(): string
  {
    return this.cwd
  }

  hasProducedTurn(): boolean
  {
    return this.producedModels.size > 0
  }

  getReliabilityTelemetry(): Array<{
    model: string
    stats: ReliabilityStats
  }>
  {
    const byModel = new Map(this.telemetryStatsByModel)
    if (this.producedModels.has(this.model))
    {
      byModel.set(
        this.model,
        mergeReliabilityStats(byModel.get(this.model), this.reliabilityStats)
      )
    }

    return [...byModel.entries()].map(([model, stats]) => ({ model, stats }))
  }

  private foldCurrentReliability(model: string): void
  {
    if (!this.producedModels.has(model)) return
    this.telemetryStatsByModel.set(
      model,
      mergeReliabilityStats(
        this.telemetryStatsByModel.get(model),
        this.reliabilityStats
      )
    )
  }

  // switch models in-place while keeping history; retire model-local MCP state,
  // rebuild the prompt, & leave host-global eviction to composition policy
  async switchModel(nextModel: string, signal?: AbortSignal): Promise<void>
  {
    signal?.throwIfAborted()
    this.lifecycleAbort.signal.throwIfAborted()
    this.contextResolutionAbort?.abort()
    await this.contextWindowPromise?.catch(() => undefined)
    signal?.throwIfAborted()
    this.lifecycleAbort.signal.throwIfAborted()

    // re-admit dynamic tools against the next model's pinned context
    const manager = this.mcpManager
    this.mcpManager = undefined
    this.installedMcpManager = undefined
    this.mcpTools = []
    this.wireToolCatalog()
    await this.retireMcpManager(manager)
    signal?.throwIfAborted()
    this.lifecycleAbort.signal.throwIfAborted()

    // stage every fallible derivation before the synchronous model commit
    const systemContent = this.buildSystemContent(nextModel)
    const previousModel = this.model
    this.foldCurrentReliability(previousModel)
    this.reliabilityStats = makeReliabilityStats()

    // swap to the new model & reset cached context window + pinned num_ctx
    // (a different model means a different runner, so the KV cache is cold anyway)
    this.model = nextModel
    this.contextWindowSize = 0
    this.numCtx = 0

    // rebuild the system prompt w/ the new model name
    this.replaceSystemPrompt(systemContent)

    // start keep-alive for the new model
    this.client.startKeepAlive(nextModel)
  }

  // override compaction configuration
  setCompactionConfig(config: Partial<CompactionConfig>): void
  {
    this.compactionConfig = { ...this.compactionConfig, ...config }
  }

  // reset conversation history to just the system prompt
  // returns the number of messages that were cleared
  clearHistory(): number
  {
    return this.state.clearHistory()
  }

  // force conversation compaction & return before/after stats
  // returns null if compaction was skipped (too few messages or summary failed)
  async forceCompact(signal?: AbortSignal): Promise<CompactionResult | null>
  {
    if (this.state.getMessageCount() < 4) return null

    // direct /compact can run before the first normal turn; resolve & pin the
    // exact window so summary requests never budget against an unsent fallback
    await this.fetchContextWindow(signal)
    signal?.throwIfAborted()

    const prepared = this.state.prepareSummary({
      mode: 'manual',
      config: this.compactionConfig,
    })
    if (!prepared) return null

    const summary = await this.buildCompactionSummary(prepared.messages, signal)
    if (summary === null) return null
    const committed = this.state.commitSummary(
      prepared.plan,
      summary,
      new Date().toISOString()
    )
    if (committed.status === 'stale') return null
    return this.reportCompaction(committed.transition)
  }

  // get the estimated token count for the current conversation
  getEstimatedTokens(): number
  {
    return this.contextTokenEstimate()
  }

  // expose the exact last request plan for status/tests without mutable state
  getLastRequestBudget(): RequestBudgetBreakdown | undefined
  {
    const budget = this.lastRequestBudget
    if (!budget) return undefined
    return {
      ...budget,
      categories: { ...budget.categories },
    }
  }

  // get the message count (excluding system prompt)
  getMessageCount(): number
  {
    return Math.max(this.state.getMessageCount() - 1, 0)
  }

  // get accumulated token usage & model time from Ollama
  // durations are nanoseconds (Ollama's native unit)
  getTokenUsage(): {
    promptTokens: number
    completionTokens: number
    promptEvalDurationNs: number
    evalDurationNs: number
  }
  {
    return {
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
      promptEvalDurationNs: this.totalPromptEvalDurationNs,
      evalDurationNs: this.totalEvalDurationNs,
    }
  }

  // zero cumulative usage counters — used after undo/redo so /status matches live history
  resetTokenUsage(): void
  {
    this.totalPromptTokens = 0
    this.totalCompletionTokens = 0
    this.totalPromptEvalDurationNs = 0
    this.totalEvalDurationNs = 0
  }

  // reset counters that belong to one saved conversation lineage
  resetSessionMetrics(): void
  {
    this.resetTokenUsage()
    this.state.resetCompactionMetrics()
  }

  // get the total number of successful compaction events this session
  getCompactionCount(): number
  {
    return this.state.getCompactionMetrics().successfulCount
  }

  // post-edit self-check toggle (runtime via /verify)
  getVerifyEdits(): boolean
  {
    return this.verifyEdits
  }

  setVerifyEdits(enabled: boolean): void
  {
    this.verifyEdits = enabled
  }

  // get the ISO timestamp of the last successful compaction (null if none)
  getLastCompactedAt(): string | null
  {
    return this.state.getCompactionMetrics().lastCompactedAt
  }

  // get reliability-layer counters for this session
  getReliabilityStats(): ReliabilityStats
  {
    return { ...this.reliabilityStats }
  }

  // frozen-prefix coverage for /status — the leading messages (system prompt +
  // accumulated summary blocks) kept byte-stable so the KV-cache prefix can
  // survive compaction.
  // ! Coral bookkeeping only — SWA/MLX models (default gemma) re-prefill
  // regardless, so this is not a measured server-side cache hit
  getFrozenPrefix(): {
    messages: number
    summaryBlocks: number
    tokens: number
    contextWindow: number
  }
  {
    const prefix = this.state.getFrozenPrefix()
    const prefixLength = this.state.getFrozenPrefixLength()
    return {
      messages: prefixLength,
      summaryBlocks: Math.max(prefixLength - 1, 0),
      tokens: prefix.reduce(
        (total, message) => total + estimateMessageTokens(message),
        0
      ),
      contextWindow: this.contextWindowSize,
    }
  }

  // fetch the model's context window from Ollama, cap it to a sane ceiling, &
  // pin it as num_ctx for the session. safe to call multiple times — only the
  // first resolution does work. capping keeps KV-cache memory bounded;
  // compaction targets the request prompt limit, not the full window
  async fetchContextWindow(signal?: AbortSignal): Promise<number>
  {
    signal?.throwIfAborted()
    this.lifecycleAbort.signal.throwIfAborted()
    if (this.contextWindowSize > 0) return this.contextWindowSize

    // share one in-flight request; clear the memo on settle so a transient
    // failure (numCtx still 0) retries on the next call instead of sticking
    if (!this.contextWindowPromise)
    {
      const controller = new AbortController()
      this.contextResolutionAbort = controller
      const resolutionSignal = AbortSignal.any([
        this.lifecycleAbort.signal,
        controller.signal,
      ])
      const pending = this.resolveContextWindow(resolutionSignal).finally(
        () =>
        {
          if (this.contextWindowPromise === pending)
          {
            this.contextWindowPromise = undefined
            this.contextResolutionAbort = undefined
          }
        }
      )
      this.contextWindowPromise = pending
    }

    const callerSignal = signal
      ? AbortSignal.any([signal, this.lifecycleAbort.signal])
      : this.lifecycleAbort.signal
    return raceAbort(this.contextWindowPromise, callerSignal)
  }

  // resolve the context window once: size it to the memory budget, cap to the
  // native window & any user override, pin it as num_ctx, & cap the compaction
  // working-set well below it (SWA/MLX re-prefills the whole prompt each turn)
  private async resolveContextWindow(signal?: AbortSignal): Promise<number>
  {
    const requestedModel = this.model
    const resolved = await resolvePinnedContextWindow(
      {
        model: requestedModel,
        cwd: this.cwd,
        totalMemBytes: totalmem(),
        showModel: (model, requestSignal) =>
          this.client.showModel(model, requestSignal),
        listModels: (requestSignal) => this.client.listModels(requestSignal),
      },
      signal
    )

    if (this.model !== requestedModel) return this.contextWindowSize

    // pin the same explicit fallback the request budget uses when metadata is
    // unavailable; leaving num_ctx unset would let Ollama choose a smaller
    // server default than the window Coral approved
    const contextWindow = resolved?.contextWindow ?? MIN_NUM_CTX
    this.contextWindowSize = contextWindow
    this.numCtx = contextWindow
    this.compactionConfig = {
      ...this.compactionConfig,
      contextWindow: requestBudgetCapacity(contextWindow).promptLimit,
    }
    this.replaceSystemPrompt(this.buildSystemContent(this.model))

    return this.contextWindowSize
  }

  // append through the dedicated conversation invariant owner
  private pushMessage(message: OllamaMessage): void
  {
    this.state.appendMessage(message)
  }

  private pushMessages(messages: readonly OllamaMessage[]): void
  {
    this.state.appendMessages(messages)
  }

  // clear compaction callbacks when the run() loop exits
  private clearCompactionCallbacks(): void
  {
    this.onCompactionCallback = undefined
    this.onCompactionStartCallback = undefined
  }

  // rebuild the immutable active snapshot after dynamic tool changes
  private wireToolCatalog(): void
  {
    this.toolCatalog = new ToolCatalog({
      trustedTools: this.baseTools,
      dynamicTools: this.mcpTools,
    })
  }

  private refreshTools(): void
  {
    this.wireToolCatalog()
    this.replaceSystemPrompt(this.buildSystemContent(this.model))
  }

  // presentation snapshot for dynamic MCP tools — static tools resolve their
  // display via the TUI registry; snapshots keep historical blocks immutable
  // across later tool refreshes
  private mcpPresentation(name: string): ToolCallPresentation | undefined
  {
    return this.toolCatalog.presentationFor(name)
  }

  private initializeMcp(
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void>
  {
    const bootstrapSignal = signal
      ? AbortSignal.any([signal, this.lifecycleAbort.signal])
      : this.lifecycleAbort.signal
    if (!this.mcpEnabled || bootstrapSignal.aborted) return Promise.resolve()
    if (this.mcpBootstrapPromise)
    {
      return raceAbort(this.mcpBootstrapPromise, bootstrapSignal)
    }

    const bootstrap = this.initializeMcpInternal(events, bootstrapSignal)
    this.mcpBootstrapPromise = bootstrap
    const clear = () =>
    {
      if (this.mcpBootstrapPromise === bootstrap)
      {
        this.mcpBootstrapPromise = undefined
      }
    }
    bootstrap.then(clear, clear)
    return bootstrap
  }

  private async initializeMcpInternal(
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void>
  {
    const existing = this.mcpManager
    const manager = existing ?? (await this.createMcpManager())
    // dispose a manager created after an aborted dynamic import
    if (!this.mcpEnabled || signal?.aborted)
    {
      if (!existing) await manager.dispose()
      return
    }

    this.mcpManager ??= manager
    if (this.mcpManager !== manager)
    {
      if (!existing) await manager.dispose()
      return
    }
    if (this.installedMcpManager === manager) return

    let tools: Tool[]
    try
    {
      tools = await manager.initialize({
        signal,
        onLaunchApproval: events.onMcpLaunchApproval,
      })
    }
    catch (error)
    {
      await this.retireUninstalledMcpManager(manager).catch(() => undefined)
      throw error
    }
    if (this.mcpManager !== manager) return
    if (signal?.aborted)
    {
      await this.retireUninstalledMcpManager(manager)
      return
    }

    // one unresolved launch means the manager's capability snapshot is not
    // final. fail closed for this turn, including any peers that became ready,
    // then rebuild later so a caller w/ an approval surface can retry trust.
    if (
      manager
        .getStatus()
        .servers.some((server) => server.state === 'needs_trust')
    )
    {
      await this.retireUninstalledMcpManager(manager)
      return
    }

    // stage the discovered catalog as one capability snapshot; if its schemas
    // plus prompt prose cannot fit even after project-context shrink, restore
    // the prior catalog & fail before any dynamic tool becomes dispatchable
    const previousTools = this.mcpTools
    const previousSystem = this.state.getMessages()[0]?.content
    this.mcpTools = tools
    this.wireToolCatalog()
    try
    {
      if (this.acceptedTurn)
      {
        this.fitSystemPromptToBudget(this.acceptedTurn.anchor)
      }
      else
      {
        this.replaceSystemPrompt(this.buildSystemContent(this.model))
      }
    }
    catch (error)
    {
      this.mcpTools = previousTools
      this.wireToolCatalog()
      if (previousSystem !== undefined)
      {
        this.replaceSystemPrompt(previousSystem)
      }
      throw error
    }
    this.installedMcpManager = manager
  }

  // build the system prompt for a model — same wiring at construct & switch
  private buildSystemContent(
    model: string,
    projectContextBudget = projectContextBudgetForWindow(this.contextWindowSize)
  ): string
  {
    return buildSystemPrompt({
      model,
      cwd: this.cwd,
      catalog: this.toolCatalog,
      projectContextBudget,
    })
  }

  // shrink only auto-loaded project context until fixed request sources fit
  private fitSystemPromptToBudget(anchor: ConversationMessageAnchor): void
  {
    const activeMessage = this.state.getMessage(anchor)
    if (!activeMessage)
    {
      throw new Error('Accepted turn is no longer present in Agent history')
    }
    const contextWindow = this.numCtx || this.contextWindowSize || MIN_NUM_CTX
    const capacity = requestBudgetCapacity(contextWindow)
    const baseContent = this.buildSystemContent(this.model, 0)
    const baseMessage: OllamaMessage = {
      role: 'system',
      content: baseContent,
    }
    const activeBase: OllamaMessage = {
      role: 'user',
      content: activeMessage.displayContent ?? activeMessage.content,
    }
    const systemBase = estimateModelRequestMessageTokens(baseMessage)
    const activeTurnBase = estimateModelRequestMessageTokens(activeBase)
    const toolDefinitions = estimateModelRequestToolTokens(
      this.toolCatalog.ollamaTools
    )
    const framing = estimateRequestFramingTokens(2)
    const baseBreakdown = createRequestBudgetBreakdown(contextWindow, {
      systemBase,
      activeTurnBase,
      toolDefinitions,
      framing,
    })

    if (!baseBreakdown.fits)
    {
      this.replaceSystemPrompt(baseContent)
      this.lastRequestBudget = baseBreakdown
      assertRequestBudget(baseBreakdown)
    }

    const desiredBudget = projectContextBudgetForWindow(contextWindow)
    const desiredContent = this.buildSystemContent(this.model, desiredBudget)
    const desiredProjectContext = estimateModelRequestMessageDeltaTokens(
      baseMessage,
      { role: 'system', content: desiredContent }
    )
    const desiredBreakdown = createRequestBudgetBreakdown(contextWindow, {
      systemBase,
      projectContext: desiredProjectContext,
      activeTurnBase,
      toolDefinitions,
      framing,
    })
    if (desiredBreakdown.fits)
    {
      this.replaceSystemPrompt(desiredContent)
      this.compactionConfig.contextWindow = capacity.promptLimit
      return
    }

    let low = 0
    let high = Math.max(desiredBudget - 1, 0)
    let bestContent = baseContent

    while (low <= high)
    {
      const budget = Math.floor((low + high) / 2)
      const content = this.buildSystemContent(this.model, budget)
      const finalSystem: OllamaMessage = { role: 'system', content }
      const projectContext = estimateModelRequestMessageDeltaTokens(
        baseMessage,
        finalSystem
      )
      const candidate = createRequestBudgetBreakdown(contextWindow, {
        systemBase,
        projectContext,
        activeTurnBase,
        toolDefinitions,
        framing,
      })

      if (candidate.fits)
      {
        bestContent = content
        low = budget + 1
      }
      else
      {
        high = budget - 1
      }
    }

    this.replaceSystemPrompt(bestContent)
    this.compactionConfig.contextWindow = capacity.promptLimit
  }

  private replaceSystemPrompt(systemContent: string): void
  {
    this.state.replaceSystemMessage(systemContent)
  }

  // give explicit current-turn attachments half of the flexible prompt space
  private attachmentBudgetChars(
    anchor: ConversationMessageAnchor,
    cleanContent: string
  ): number
  {
    const system = this.state.getMessages()[0]!
    const fixedPromptTokens =
      estimateModelRequestMessageTokens(system) +
      estimateModelRequestMessageTokens({
        role: 'user',
        content: cleanContent,
      }) +
      estimateModelRequestToolTokens(this.toolCatalog.ollamaTools) +
      estimateRequestFramingTokens(2)
    const capacity = requestBudgetCapacity(
      this.numCtx || this.contextWindowSize || MIN_NUM_CTX
    )
    // the anchor is intentionally part of the signature: this allocation
    // belongs to the exact admitted turn, never to historical attachment data
    if (this.state.indexOf(anchor) < 0) return 0
    return (
      attachmentAllowanceForFixedCost(capacity.promptLimit, fixedPromptTokens) *
      CHARS_PER_TOKEN
    )
  }

  // retain the semantic Git headline before omitting reconstructible detail
  private compactGitContext(
    gitContext: OllamaMessage | null
  ): OllamaMessage | null
  {
    if (!gitContext) return null
    const keep = /^(## Git Context|- (root|cwd|branch|operation|status):)/
    const lines = gitContext.content
      .split('\n')
      .filter((line) => keep.test(line))
    if (lines.length <= 1) return null
    return {
      role: 'system',
      content: `${lines.join('\n')}\n- detail: omitted to fit request budget`,
    }
  }

  // hard-fit fallback: consolidate every older live/frozen block while keeping
  // the system prompt & the complete active turn byte-stable
  private async compactHistoryForHardFit(
    anchor: ConversationMessageAnchor,
    signal?: AbortSignal
  ): Promise<boolean>
  {
    signal?.throwIfAborted()
    if (this.state.indexOf(anchor) <= 1) return false
    const prepared = this.state.prepareSummary({ mode: 'hard-fit' })
    if (!prepared) return false
    const summary = await this.buildCompactionSummary(prepared.messages, signal)
    signal?.throwIfAborted()
    if (summary === null) return false
    const committed = this.state.commitSummary(
      prepared.plan,
      summary,
      new Date().toISOString()
    )
    if (committed.status === 'stale') return false
    this.reportCompaction(committed.transition)
    return true
  }

  // append volatile repo state to the request only; keep session history stable
  private buildRequestMessages(
    gitContext: OllamaMessage | null,
    anchor?: ConversationMessageAnchor,
    activeContent?: string
  ): ModelRequestMessage[]
  {
    const stored = this.state.getMessages()
    const activeIndex = anchor ? this.state.indexOf(anchor) : -1
    if (anchor && activeIndex < 0)
    {
      throw new Error('Accepted turn is no longer present in Agent history')
    }
    if (activeIndex >= 0 && activeContent !== undefined)
    {
      stored[activeIndex] = { ...stored[activeIndex]!, content: activeContent }
    }
    const messages = gitContext ? [...stored, gitContext] : stored
    return messages.map(toModelRequestMessage)
  }

  // categorize one exact allowlisted request without double-counting sources
  private buildRequestBudget(
    messages: readonly ModelRequestMessage[],
    gitContext: OllamaMessage | null,
    anchor: ConversationMessageAnchor,
    cleanContent: string
  ): RequestBudgetBreakdown
  {
    const activeIndex = this.state.indexOf(anchor)
    if (activeIndex < 0)
    {
      throw new Error('Accepted turn is no longer present in Agent history')
    }

    const system = messages[0]!
    const active = messages[activeIndex]!
    const baseSystem: ModelRequestMessage = {
      role: 'system',
      content: this.buildSystemContent(this.model, 0),
    }
    const baseActive: ModelRequestMessage = {
      role: 'user',
      content: cleanContent,
    }
    const systemBase = estimateModelRequestMessageTokens(baseSystem)
    const projectContext = estimateModelRequestMessageDeltaTokens(
      baseSystem,
      system
    )
    const activeTurnBase = estimateModelRequestMessageTokens(baseActive)
    const activeAttachments = estimateModelRequestMessageDeltaTokens(
      baseActive,
      active
    )
    const gitContextTokens = gitContext
      ? estimateModelRequestMessageTokens(messages.at(-1)!)
      : 0
    const messageTokens = estimateModelRequestMessagesTokens(messages)
    const storedHistory = Math.max(
      messageTokens -
        estimateModelRequestMessageTokens(system) -
        estimateModelRequestMessageTokens(active) -
        gitContextTokens,
      0
    )

    return createRequestBudgetBreakdown(
      this.numCtx || this.contextWindowSize || MIN_NUM_CTX,
      {
        systemBase,
        projectContext,
        storedHistory,
        activeTurnBase,
        activeAttachments,
        toolDefinitions: estimateModelRequestToolTokens(
          this.toolCatalog.ollamaTools
        ),
        gitContext: gitContextTokens,
        framing: estimateRequestFramingTokens(messages.length),
      }
    )
  }

  private prepareAttachmentRequest(
    capturedTurn: CapturedTurn,
    maxChars: number,
    gitContext: OllamaMessage | null,
    anchor: ConversationMessageAnchor,
    cleanContent: string
  ): PreparedAttachmentRequest
  {
    const materialization = this.turnContext.materialize(capturedTurn, maxChars)
    const content = appendAttachmentContext(
      cleanContent,
      materialization.context
    )
    const messages = this.buildRequestMessages(gitContext, anchor, content)
    return {
      materialization,
      content,
      messages,
      budget: this.buildRequestBudget(
        messages,
        gitContext,
        anchor,
        cleanContent
      ),
    }
  }

  // fit ordered attachment entries against the exact post-fallback request;
  // keep each nested prefix monotonic instead of binary-searching structures
  private prepareAttachmentRequestToFit(
    capturedTurn: CapturedTurn,
    maxChars: number,
    gitContext: OllamaMessage | null,
    anchor: ConversationMessageAnchor,
    cleanContent: string
  ): PreparedAttachmentRequest
  {
    const materialization = this.turnContext.materializeToFit(
      capturedTurn,
      maxChars,
      (context) =>
      {
        const content = appendAttachmentContext(cleanContent, context)
        const messages = this.buildRequestMessages(gitContext, anchor, content)
        return this.buildRequestBudget(
          messages,
          gitContext,
          anchor,
          cleanContent
        ).fits
      }
    )
    const content = appendAttachmentContext(
      cleanContent,
      materialization.context
    )
    const messages = this.buildRequestMessages(gitContext, anchor, content)
    return {
      materialization,
      content,
      messages,
      budget: this.buildRequestBudget(
        messages,
        gitContext,
        anchor,
        cleanContent
      ),
    }
  }

  // reserve all protocol replies before executing a tool round, then expose
  // only the aggregate exact-token allowance shared by those sibling results
  private async prepareToolResultRoundBudget(
    assistantMessage: OllamaMessage,
    toolCalls: readonly OllamaToolCall[],
    anchor: ConversationMessageAnchor,
    cleanContent: string,
    signal?: AbortSignal
  ): Promise<ToolResultRoundBudget>
  {
    const minimumMessages = toolCalls.map((call) =>
      this.minimumToolResultMessage(call.function.name)
    )
    const projectBudget = (): RequestBudgetBreakdown =>
    {
      const messages = [
        ...this.state.getMessages(),
        assistantMessage,
        ...minimumMessages,
      ].map(toModelRequestMessage)
      return this.buildRequestBudget(messages, null, anchor, cleanContent)
    }

    let projected = projectBudget()
    if (!projected.fits)
    {
      const baseSystem = this.buildSystemContent(this.model, 0)
      if (this.state.getMessages()[0]?.content !== baseSystem)
      {
        this.replaceSystemPrompt(baseSystem)
        projected = projectBudget()
      }
    }
    if (!projected.fits)
    {
      await this.compactHistoryForHardFit(anchor, signal)
      signal?.throwIfAborted()
      projected = projectBudget()
    }
    if (!projected.fits)
    {
      this.lastRequestBudget = projected
      assertRequestBudget(projected)
    }

    const baseMessages = [...this.state.getMessages(), assistantMessage].map(
      toModelRequestMessage
    )
    const capacity = requestBudgetCapacity(
      this.numCtx || this.contextWindowSize || MIN_NUM_CTX
    )
    const basePromptTokens =
      estimateModelRequestMessagesTokens(baseMessages) +
      estimateModelRequestToolTokens(this.toolCatalog.ollamaTools) +
      estimateRequestFramingTokens(baseMessages.length + minimumMessages.length)
    const minimumTokens = minimumMessages.map(estimateModelRequestMessageTokens)
    const remainingMinimumTokens = minimumTokens.reduce(
      (total, tokens) => total + tokens,
      0
    )
    const remainingTokens = capacity.promptLimit - basePromptTokens
    if (remainingTokens < remainingMinimumTokens)
    {
      throw new Error(
        'Tool-result round reservation drifted from request budget'
      )
    }

    return {
      minimumTokens,
      nextResult: 0,
      remainingCalls: minimumMessages.length,
      remainingMinimumTokens,
      remainingTokens,
    }
  }

  private contextTokenEstimate(volatileTokens = 0): number
  {
    return this.contextTokenEstimateForStored(
      this.state.getEstimatedTokens(),
      this.state.getMessageCount(),
      volatileTokens
    )
  }

  private contextTokenEstimateForStored(
    storedTokens: number,
    messageCount: number,
    volatileTokens = 0
  ): number
  {
    return (
      storedTokens +
      this.toolCatalog.definitionTokens +
      estimateRequestFramingTokens(messageCount) +
      volatileTokens
    )
  }

  private reportCompaction(
    transition: ConversationTransition
  ): CompactionResult
  {
    const result: CompactionResult = {
      type: transition.type,
      beforeTokens: this.contextTokenEstimateForStored(
        transition.beforeStoredTokens,
        transition.beforeMessages
      ),
      afterTokens: this.contextTokenEstimateForStored(
        transition.afterStoredTokens,
        transition.afterMessages
      ),
      beforeMessages: transition.beforeMessages,
      afterMessages: transition.afterMessages,
      ...(transition.prunedResults === undefined
        ? {}
        : { prunedResults: transition.prunedResults }),
    }
    this.onCompactionCallback?.(result)
    return result
  }

  // clean run() exit: drop compaction callbacks & signal completion
  private finishRun(events: AgentEvents): void
  {
    this.clearCompactionCallbacks()
    events.onDone()
  }

  // on abort, record whatever streamed so far as a partial assistant message
  private recordPartialOnAbort(
    fullContent: string,
    fullThinking: string
  ): void
  {
    if (!fullContent && !fullThinking) return
    const partial: OllamaMessage = {
      role: 'assistant',
      content: fullContent || '(interrupted)',
    }
    if (fullThinking) partial.thinking = fullThinking
    this.pushMessage(partial)
    this.producedModels.add(this.model)
  }

  // preserve summary instructions & the newest transcript tail while fitting
  // the compaction request through the same conservative UTF-8 estimator
  private fitCompactionPrompt(
    content: string,
    maxTokens: number
  ): string | null
  {
    const fits = (candidate: string) =>
      estimateModelRequestMessageTokens({
        role: 'user',
        content: candidate,
      }) <= maxTokens
    if (fits(content)) return content

    const marker = '\n\n[older transcript middle omitted to fit budget]\n\n'
    if (!fits(marker)) return null
    let low = 0
    let high = content.length
    let best = marker

    while (low <= high)
    {
      const retained = Math.floor((low + high) / 2)
      const headChars = Math.min(Math.floor(retained / 3), 2_000)
      const tailChars = Math.max(retained - headChars, 0)
      const candidate = `${content.slice(0, headChars)}${marker}${
        tailChars > 0 ? content.slice(-tailChars) : ''
      }`
      if (fits(candidate))
      {
        best = candidate
        low = retained + 1
      }
      else
      {
        high = retained - 1
      }
    }
    return best
  }

  // build a model-generated summary for older messages
  // returns null when the model call fails or yields an empty summary
  private async buildCompactionSummary(
    messagesToSummarize: OllamaMessage[],
    signal?: AbortSignal
  ): Promise<string | null>
  {
    const cleaned = stripThinkingForCompaction(messagesToSummarize)
    const fullPrompt = buildCompactionPrompt(cleaned)
    const capacity = requestBudgetCapacity(
      this.numCtx || this.contextWindowSize || MIN_NUM_CTX
    )
    const systemMessage: ModelRequestMessage = {
      role: 'system',
      content: COMPACTION_SYSTEM_PROMPT,
    }
    const promptTokens =
      capacity.summaryPromptLimit -
      estimateModelRequestMessageTokens(systemMessage) -
      estimateRequestFramingTokens(2)
    const compactionPrompt = this.fitCompactionPrompt(fullPrompt, promptTokens)
    if (compactionPrompt === null) return null
    let summary = ''

    this.onCompactionStartCallback?.()

    try
    {
      for await (const chunk of this.client.chatStream(
        {
          model: this.model,
          messages: [
            systemMessage,
            { role: 'user', content: compactionPrompt },
          ],
          num_ctx: this.numCtx || undefined,
          num_predict: capacity.summaryResponseReserve,
        },
        signal
      ))
      {
        if (signal?.aborted) return null
        if (chunk.message.content)
        {
          summary += chunk.message.content
        }
      }
    }
    catch
    {
      return null
    }

    if (!summary.trim()) return null

    return summary
  }

  // look up a tool in this agent's own toolset — scoping lookup here (not the
  // global registry) keeps subagents from reaching tools outside their subset
  private getOwnTool(name: string): Tool | undefined
  {
    return this.toolCatalog.get(name)
  }

  // canonicalize hallucinated name variants (Read_File -> read_file) in place
  // so history, dispatch, & the UI all see the registered name
  private repairToolNames(toolCalls: OllamaToolCall[]): void
  {
    for (const call of toolCalls)
    {
      const name = call.function.name
      if (this.getOwnTool(name)) continue

      const normalized = normalizeToolName(name)
      const match = this.toolCatalog.tools.find(
        (t) => normalizeToolName(t.name) === normalized
      )

      if (match)
      {
        call.function.name = match.name
        this.reliabilityStats.nameRepairs++
      }
    }
  }

  // resolve the effective policy given a precomputed workspace-crossing flag —
  // an always_allow tool still needs approval when it leaves the workspace
  private resolveInvocationPolicy(
    toolName: string,
    crossesWorkspace: boolean
  ): ToolPermissions[string]
  {
    const policy = getToolPolicy(this.permissions, toolName)
    if (policy === 'always_allow' && crossesWorkspace)
    {
      return 'require_approval'
    }

    return policy
  }

  // identify approval-free tools that can run out of order internally
  // while keeping the live policy check so approval-gated tools still serialize
  private getInvocationPolicy(
    toolName: string,
    args: Record<string, unknown>
  ): ToolPermissions[string]
  {
    return this.resolveInvocationPolicy(
      toolName,
      requiresWorkspacePathApproval(toolName, args, this.cwd)
    )
  }

  private canRunToolInParallel(
    toolName: string,
    args: Record<string, unknown>
  ): boolean
  {
    return (
      this.toolCatalog.getProfile(toolName)?.parallelSafe === true &&
      this.getInvocationPolicy(toolName, args) === 'always_allow'
    )
  }

  // build request-scoped context for tools that need runtime dependencies —
  // allowOutsideWorkspace is computed once per invocation & threaded in so the
  // approval decision & execution can't disagree about the workspace boundary
  private buildToolExecutionContext(
    allowOutsideWorkspace: boolean,
    signal?: AbortSignal
  ): ToolExecutionContext
  {
    return {
      cwd: this.cwd,
      ollamaHost: this.baseUrl ?? DEFAULT_OLLAMA_HOST,
      allowOutsideWorkspace,
      subagentRunner: this.subagentRunner,
      codeIntel: this.codeIntel,
      todoState: this.todoState,
      signal,
    }
  }

  // execute a registered tool & convert thrown errors to tool results
  private async executeTool(
    toolName: string,
    toolArgs: Record<string, unknown>,
    allowOutsideWorkspace: boolean,
    signal?: AbortSignal
  ): Promise<ToolResult>
  {
    // both serial & parallel dispatch resolve the tool & skip unknown names
    // before calling executeTool, so resolution here can't miss
    const tool = this.getOwnTool(toolName)!

    // schema-check & coerce args before executing — a friendly error here lets
    // the model retry w/ fixed args instead of hitting a runtime failure
    const validation = validateToolArgs(tool, toolArgs)
    if (!validation.ok)
    {
      this.reliabilityStats.validationFailures++
      return toolError(validation.error)
    }

    try
    {
      const result = await tool.execute(
        validation.args,
        this.buildToolExecutionContext(allowOutsideWorkspace, signal)
      )
      // a tool that recovered a near-miss call (e.g. whitespace-tolerant edit)
      // counts as a compensation the model made us do
      if (result.repaired) this.reliabilityStats.editRepairs++
      return result
    }
    catch (err)
    {
      return toolError(
        `Tool execution failed for ${toolName}: ${toErrorMessage(err)}`
      )
    }
  }

  private minimumToolResultMessage(toolName: string): OllamaMessage
  {
    return {
      role: 'tool',
      tool_name: toolName,
      content: `Error: ${TOOL_RESULT_REDACTED_OMITTED}`,
    }
  }

  // fit one result into its fair share of the exact aggregate round allowance;
  // unused space rolls forward while every later sibling keeps a minimum reply
  private buildToolMessage(
    toolName: string,
    output: string,
    error: string | undefined,
    roundBudget: ToolResultRoundBudget
  ): OllamaMessage
  {
    const cappedError = error
      ? trimTrailingHighSurrogate(capErrorMessage(error))
      : error
    const rawContent = cappedError
      ? output
        ? `Error: ${cappedError}\n${output}`
        : `Error: ${cappedError}`
      : output
    const minimumTokens = roundBudget.minimumTokens[roundBudget.nextResult]
    if (minimumTokens === undefined || roundBudget.remainingCalls <= 0)
    {
      throw new Error('Tool-result round budget consumed out of order')
    }

    const extraTokens = Math.max(
      roundBudget.remainingTokens - roundBudget.remainingMinimumTokens,
      0
    )
    const maxTokens =
      minimumTokens + Math.floor(extraTokens / roundBudget.remainingCalls)
    const redactionNote = rawContent.includes('[redacted]')
      ? '\n[redacted] content was present in omitted output'
      : ''
    const marker =
      `\n\n[output truncated from ${rawContent.length} chars to fit request budget` +
      ` — narrow the scope (e.g. diff a specific path) to see the rest]` +
      `${redactionNote}\n\n`
    const maxRetainedChars = Math.max(
      Math.min(rawContent.length - 1, MAX_TOOL_OUTPUT_CHARS - marker.length),
      0
    )
    // one stable shape makes encoded size monotonic as retainedChars grows;
    // trim split surrogate pairs so every candidate remains valid Unicode
    const messageForRetainedChars = (retainedChars: number): OllamaMessage =>
    {
      const headChars = Math.ceil(retainedChars * 0.75)
      const tailChars = Math.max(retainedChars - headChars, 0)
      const head = trimTrailingHighSurrogate(rawContent.slice(0, headChars))
      const tail =
        tailChars > 0
          ? trimLeadingLowSurrogate(rawContent.slice(-tailChars))
          : ''
      return {
        role: 'tool',
        tool_name: toolName,
        content: `${head}${marker}${tail}`,
      }
    }
    const full: OllamaMessage = {
      role: 'tool',
      tool_name: toolName,
      content:
        rawContent.length <= MAX_TOOL_OUTPUT_CHARS
          ? rawContent
          : messageForRetainedChars(maxRetainedChars).content,
    }
    let message = full

    if (estimateModelRequestMessageTokens(full) > maxTokens)
    {
      const notice = redactionNote
        ? TOOL_RESULT_REDACTED_OMITTED
        : TOOL_RESULT_OMITTED
      const fallback: OllamaMessage = {
        role: 'tool',
        tool_name: toolName,
        content: error ? `Error: ${notice}` : notice,
      }
      if (estimateModelRequestMessageTokens(fallback) > maxTokens)
      {
        throw new Error('Tool-result minimum exceeds its reserved round budget')
      }

      let low = 0
      let high = maxRetainedChars
      message = fallback
      while (low <= high)
      {
        const chars = Math.floor((low + high) / 2)
        const candidate = messageForRetainedChars(chars)
        if (estimateModelRequestMessageTokens(candidate) <= maxTokens)
        {
          message = candidate
          low = chars + 1
        }
        else
        {
          high = chars - 1
        }
      }
    }

    const usedTokens = estimateModelRequestMessageTokens(message)
    roundBudget.remainingTokens -= usedTokens
    roundBudget.remainingMinimumTokens -= minimumTokens
    roundBudget.remainingCalls -= 1
    roundBudget.nextResult += 1

    return message
  }

  // record one announced tool result in UI events, model history, guards, & diffs
  private recordToolOutcome({
    events,
    toolResults,
    roundBudget,
    doomLoop,
    editDiffs,
    fileChanges,
    todoChange,
    invocation,
    result,
    trackDoom = true,
  }: ToolOutcomeRecordParams): DoomLoopTrip | null
  {
    toolResults.push(
      this.buildToolMessage(
        invocation.name,
        result.output,
        result.error,
        roundBudget
      )
    )
    if (result.diff) editDiffs.push(result.diff)
    if (result.change) fileChanges.push(result.change)
    if (result.todoChange)
    {
      todoChange.before ??= cloneTodoItems(result.todoChange.before)
      todoChange.after = cloneTodoItems(result.todoChange.after)
    }
    const trip = trackDoom
      ? doomLoop.record(invocation.name, invocation.args, result.error)
      : null

    // commit every model, undo, & guard record before crossing into the UI;
    // a host callback failure must not erase a tool mutation from bookkeeping
    events.onToolResult(
      invocation.name,
      result.output,
      result.error,
      invocation.id,
      result.diff
    )
    return trip
  }

  // two-phase compaction: prune tool results first, then summarize if needed
  private async compactIfNeeded(
    volatileTokens = 0,
    signal?: AbortSignal
  ): Promise<void>
  {
    if (signal?.aborted) return
    const totalTokens = this.contextTokenEstimate(volatileTokens)

    // phase 1: prune old tool results (no model call, instant)
    if (
      shouldPrune(
        this.state.getMessageCount(),
        totalTokens,
        this.compactionConfig
      )
    )
    {
      const transition = this.state.pruneToolResults(new Date().toISOString())
      if (transition)
      {
        if (signal?.aborted) return
        this.reportCompaction(transition)
      }
    }

    const totalAfterPrune = this.contextTokenEstimate(volatileTokens)

    // phase 2: full summarization if still over threshold
    if (
      !shouldCompactByTotal(
        this.state.getMessageCount(),
        totalAfterPrune,
        this.compactionConfig
      )
    )
    {
      return
    }

    const prepared = this.state.prepareSummary({
      mode: 'automatic',
      config: this.compactionConfig,
    })
    if (!prepared) return

    const summary = await this.buildCompactionSummary(prepared.messages, signal)

    if (summary === null)
    {
      // a cancelled summary returns null too — treat it as cancellation, not a
      // compaction failure, so we don't increment the failure count or trim
      if (signal?.aborted) return
      const failure = this.state.recordAutomaticSummaryFailure(
        prepared.plan,
        DEFAULT_MAX_HISTORY
      )
      if (failure.status === 'recorded' && failure.transition)
      {
        this.reportCompaction(failure.transition)
      }
      return
    }

    const committed = this.state.commitSummary(
      prepared.plan,
      summary,
      new Date().toISOString()
    )
    if (committed.status === 'committed')
    {
      this.reportCompaction(committed.transition)
    }
  }

  // accept one clean semantic turn synchronously before any cancelable work
  acceptTurn(input: string | TurnInput): AcceptedTurn
  {
    this.lifecycleAbort.signal.throwIfAborted()
    if (this.acceptedTurn)
    {
      throw new Error('Agent already has an accepted turn')
    }

    const semanticInput: TurnInput =
      typeof input === 'string'
        ? { content: input }
        : {
            content: input.content,
            attachmentPaths: input.attachmentPaths
              ? Object.freeze([...input.attachmentPaths])
              : undefined,
          }
    const displayContent = semanticInput.attachmentPaths?.length
      ? semanticInput.content
      : undefined

    const handle: AcceptedTurn = Object.freeze({
      id: Symbol('accepted-turn'),
      input: Object.freeze(semanticInput),
    })
    const anchor = this.state.acceptUserMessage(
      semanticInput.content,
      displayContent
    )
    this.acceptedTurn = { handle, anchor, running: false }
    return handle
  }

  // convenience adapter for non-interactive callers w/o attachment parsing
  run(
    input: string | TurnInput,
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void>
  {
    if (this.lifecycleAbort.signal.aborted)
    {
      this.finishRun(events)
      return Promise.resolve()
    }

    const accepted = this.acceptTurn(input)
    return this.runAcceptedTurn(accepted, events, signal)
  }

  // join cancelable enrichment & inference to an already-admitted turn
  runAcceptedTurn(
    accepted: AcceptedTurn,
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void>
  {
    const active = this.acceptedTurn
    if (!active || active.handle !== accepted)
    {
      throw new Error('Accepted turn does not belong to this Agent')
    }
    if (active.running)
    {
      throw new Error('Accepted turn is already running')
    }
    active.running = true

    const runPromise = this.runInternal(active, events, signal)
    this.activeRuns.add(runPromise)
    const removeRun = () => this.activeRuns.delete(runPromise)
    void runPromise.then(removeRun, removeRun)
    return runPromise
  }

  // run a user message through the agent loop
  // combine caller cancellation w/ the Agent-owned lifecycle abort scope
  private async runInternal(
    accepted: ActiveAcceptedTurn,
    events: AgentEvents,
    externalSignal?: AbortSignal
  ): Promise<void>
  {
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, this.lifecycleAbort.signal])
      : this.lifecycleAbort.signal
    const runAnchor = accepted.anchor
    const userMessage = accepted.handle.input.content
    // diffs from edit-producing tools this run — fed to the self-check
    const editDiffs: string[] = []
    const fileChanges: UndoFileChange[] = []
    const todoChange: TodoChangeTracker = { before: null, after: null }
    let undoRecorded = false
    let terminalCallbackStarted = false
    const finalize = () =>
    {
      try
      {
        if (!undoRecorded)
        {
          // mark first so a failed undo write cannot be retried into duplicate
          // state by the outer ownership boundary
          undoRecorded = true
          this.state.finalizeActiveTurn(
            runAnchor,
            fileChanges,
            finalizedTodoChange(todoChange)
          )
        }
      }
      finally
      {
        if (this.acceptedTurn === accepted) this.acceptedTurn = undefined
      }
    }
    const finish = () =>
    {
      finalize()
      terminalCallbackStarted = true
      this.finishRun(events)
    }
    const fail = (error: Error) =>
    {
      finalize()
      this.clearCompactionCallbacks()
      terminalCallbackStarted = true
      events.onError(error)
    }

    try
    {
      if (signal.aborted)
      {
        finish()
        return
      }

      let capturedTurn: CapturedTurn
      let attachmentBudgetChars = 0
      // resolve num_ctx & active MCP capabilities before reading attachments
      try
      {
        await this.fetchContextWindow(signal)
        signal.throwIfAborted()
        await this.initializeMcp(events, signal)
        signal.throwIfAborted()
        this.fitSystemPromptToBudget(runAnchor)
        attachmentBudgetChars = this.attachmentBudgetChars(
          runAnchor,
          userMessage
        )
        capturedTurn = await this.turnContext.capture(
          accepted.handle.input,
          signal,
          attachmentBudgetChars
        )
        signal.throwIfAborted()
      }
      catch (err)
      {
        if (signal.aborted || this.lifecycleAbort.signal.aborted)
        {
          finish()
          return
        }
        fail(toError(err))
        return
      }

      // store compaction callbacks so compactIfNeeded() can invoke them
      this.onCompactionCallback = events.onCompaction
      this.onCompactionStartCallback = events.onCompactionStart

      // keep going while the model wants to call tools
      let iterations = 0
      let stallNudges = 0
      let reprompts = 0
      let verifyReprompts = 0
      const doomLoop = new DoomLoopDetector()
      let attachmentsCommitted = false
      while (true)
      {
        // check for abort before each iteration
        if (signal?.aborted)
        {
          finish()
          return
        }

        // safety cap on tool-call rounds — bounds subagent cost (unset = unlimited)
        iterations++
        if (
          this.maxIterations !== undefined &&
          iterations > this.maxIterations
        )
        {
          finish()
          return
        }

        let fullContent = ''
        let fullThinking = ''
        let toolCalls: OllamaToolCall[] = []
        // first doom-loop trip seen while executing this round's tools
        let doomTrip: DoomLoopTrip | null = null

        try
        {
          let gitContext = await this.turnContext.gatherGit(signal)
          signal.throwIfAborted()
          const activeMessage = this.state.getMessage(runAnchor)
          if (!activeMessage)
          {
            throw new Error(
              'Accepted turn is no longer present in Agent history'
            )
          }

          // account for the hypothetical complete attachment block during
          // compaction, but leave the accepted stored message clean until fit
          let pendingMaterialization = attachmentsCommitted
            ? null
            : this.turnContext.materialize(capturedTurn, attachmentBudgetChars)
          let pendingContent = pendingMaterialization
            ? appendAttachmentContext(
                userMessage,
                pendingMaterialization.context
              )
            : activeMessage.content
          const pendingAttachmentTokens = attachmentsCommitted
            ? 0
            : estimateModelRequestMessageDeltaTokens(activeMessage, {
                ...activeMessage,
                content: pendingContent,
              })
          const volatileTokens =
            (gitContext ? estimateMessageTokens(gitContext) : 0) +
            pendingAttachmentTokens

          await this.compactIfNeeded(volatileTokens, signal)
          signal.throwIfAborted()

          // preserve the active turn if the hard message-count guard fires
          if (this.state.getMessageCount() > DEFAULT_MAX_HISTORY)
          {
            this.state.trimToMax(DEFAULT_MAX_HISTORY)
          }

          let requestMessages: ModelRequestMessage[]
          let requestBudget: RequestBudgetBreakdown
          const rebuildRequest = () =>
          {
            if (!attachmentsCommitted)
            {
              const prepared = this.prepareAttachmentRequest(
                capturedTurn,
                attachmentBudgetChars,
                gitContext,
                runAnchor,
                userMessage
              )
              pendingMaterialization = prepared.materialization
              pendingContent = prepared.content
              requestMessages = prepared.messages
              requestBudget = prepared.budget
              return
            }

            requestMessages = this.buildRequestMessages(gitContext)
            requestBudget = this.buildRequestBudget(
              requestMessages,
              gitContext,
              runAnchor,
              userMessage
            )
          }
          rebuildRequest()

          // Git is volatile & reconstructible: compact it, then omit it before
          // any protected conversation or captured user bytes are sacrificed
          if (!requestBudget!.fits && gitContext)
          {
            gitContext = this.compactGitContext(gitContext)
            rebuildRequest()
          }
          if (!requestBudget!.fits && gitContext)
          {
            gitContext = null
            rebuildRequest()
          }

          // auto-loaded project text is lower priority than explicit turn input
          if (!requestBudget!.fits)
          {
            const baseSystem = this.buildSystemContent(this.model, 0)
            if (this.state.getMessages()[0]?.content !== baseSystem)
            {
              this.replaceSystemPrompt(baseSystem)
              rebuildRequest()
            }
          }

          // when normal thresholds were insufficient, consolidate only history
          // older than the active turn & remeasure the exact projected request
          if (!requestBudget!.fits)
          {
            await this.compactHistoryForHardFit(runAnchor, signal)
            signal.throwIfAborted()
            rebuildRequest()
          }

          // current attachments are the final reducible durable source; fit
          // ordered entries against the exact post-fallback request, then
          // commit expanded bytes & their ui-only outcome report together
          if (!attachmentsCommitted)
          {
            const fitted = this.prepareAttachmentRequestToFit(
              capturedTurn,
              attachmentBudgetChars,
              gitContext,
              runAnchor,
              userMessage
            )
            pendingMaterialization = fitted.materialization
            pendingContent = fitted.content
            requestMessages = fitted.messages
            requestBudget = fitted.budget
          }

          this.lastRequestBudget = requestBudget!
          assertRequestBudget(requestBudget!)
          signal.throwIfAborted()

          if (!attachmentsCommitted)
          {
            const attachmentMaterialization =
              (accepted.handle.input.attachmentPaths?.length ?? 0) > 0
                ? pendingMaterialization!
                : undefined
            const committed = this.state.commitActiveUserMessage(
              runAnchor,
              pendingContent,
              attachmentMaterialization
                ? attachmentReportFromMaterialization(attachmentMaterialization)
                : undefined
            )
            if (!committed)
            {
              throw new Error(
                'Accepted turn is no longer present in Agent history'
              )
            }
            attachmentsCommitted = true
            if (attachmentMaterialization)
            {
              events.onAttachments?.(attachmentMaterialization)
            }
          }

          for await (const chunk of this.client.chatStream(
            {
              model: this.model,
              messages: requestMessages!,
              tools: [...this.toolCatalog.ollamaTools],
              think: this.thinkMode,
              num_ctx: this.numCtx || undefined,
              num_predict: requestBudget!.responseReserve,
            },
            signal
          ))
          {
            if (signal?.aborted) break

            if (chunk.message.thinking)
            {
              fullThinking += chunk.message.thinking
              events.onThinking?.(chunk.message.thinking)
            }
            if (chunk.message.content)
            {
              fullContent += chunk.message.content
              events.onToken(chunk.message.content)
            }
            if (chunk.message.tool_calls?.length)
            {
              toolCalls = mergeToolCalls(toolCalls, chunk.message.tool_calls)
            }
            // capture token usage & model time from the final chunk
            if (chunk.done)
            {
              const promptTokens = chunk.prompt_eval_count ?? 0
              const completionTokens = chunk.eval_count ?? 0
              const promptEvalDurationNs = chunk.prompt_eval_duration
              const evalDurationNs = chunk.eval_duration
              this.totalPromptTokens += promptTokens
              this.totalCompletionTokens += completionTokens
              if (promptEvalDurationNs && promptEvalDurationNs > 0)
              {
                this.totalPromptEvalDurationNs += promptEvalDurationNs
              }
              if (evalDurationNs && evalDurationNs > 0)
              {
                this.totalEvalDurationNs += evalDurationNs
              }
              events.onUsage?.({
                promptTokens,
                completionTokens,
                totalPromptTokens: this.totalPromptTokens,
                totalCompletionTokens: this.totalCompletionTokens,
                contextTokens: requestBudget!.promptTokens,
                promptEvalDurationNs,
                evalDurationNs,
                totalPromptEvalDurationNs: this.totalPromptEvalDurationNs,
                totalEvalDurationNs: this.totalEvalDurationNs,
              })
            }
          }
        }
        catch (err)
        {
          // treat fetch abort as a clean cancellation, not an error
          if (signal?.aborted)
          {
            // record whatever we streamed so far as a partial message
            this.recordPartialOnAbort(fullContent, fullThinking)
            finish()
            return
          }

          // record undo for prior mutations w/o signaling clean completion
          fail(toError(err))
          return
        }

        // aborted mid-stream — save partial content & stop
        if (signal?.aborted)
        {
          this.recordPartialOnAbort(fullContent, fullThinking)
          finish()
          return
        }

        // repair pass: recover tool calls the model emitted as text content —
        // the most common local-model failure mode (call-shaped JSON, no call)
        if (toolCalls.length === 0 && fullContent.trim())
        {
          const repaired = parseToolCallsFromContent(
            fullContent,
            this.toolCatalog.names
          )

          if (repaired)
          {
            toolCalls = repaired
            this.reliabilityStats.repairedToolCalls += repaired.length
          }
        }

        // fix hallucinated tool-name variants before the calls reach history
        this.repairToolNames(toolCalls)

        // record assistant message — after repair, so history carries the
        // recovered tool_calls instead of raw JSON the model would re-see
        const assistantMessage: OllamaMessage = {
          role: 'assistant',
          content: fullContent,
        }
        if (fullThinking)
        {
          assistantMessage.thinking = fullThinking
        }
        if (toolCalls.length > 0)
        {
          assistantMessage.tool_calls = toolCalls.map(storedToolCall)
        }

        let toolResultBudget: ToolResultRoundBudget | undefined
        if (toolCalls.length > 0)
        {
          try
          {
            toolResultBudget = await this.prepareToolResultRoundBudget(
              assistantMessage,
              toolCalls,
              runAnchor,
              userMessage,
              signal
            )
          }
          catch (err)
          {
            if (signal?.aborted)
            {
              finish()
              return
            }
            fail(toError(err))
            return
          }
        }
        this.producedModels.add(this.model)

        // no tool calls means the model is done
        if (toolCalls.length === 0)
        {
          this.pushMessage(assistantMessage)
          // stall nudge: a fully empty turn (no content, no thinking) is a
          // dead end, not an answer — prod the model, bounded by the cap
          if (
            !fullContent.trim() &&
            !fullThinking.trim() &&
            stallNudges < MAX_STALL_NUDGES
          )
          {
            stallNudges++
            this.reliabilityStats.stallNudges++
            this.pushMessage({ role: 'user', content: STALL_NUDGE_MESSAGE })
            continue
          }

          // reprompt: the turn looks like a botched call the repair pass couldn't
          // recover — prod the model to re-emit a valid one, bounded by the cap
          if (
            reprompts < MAX_REPROMPTS &&
            fullContent.trim() &&
            looksLikeAttemptedToolCall(fullContent, this.toolCatalog.names)
          )
          {
            reprompts++
            this.reliabilityStats.reprompts++
            this.pushMessage({ role: 'user', content: REPROMPT_MESSAGE })
            continue
          }

          // clean completion — optionally self-check this run's edits before done
          if (this.verifyEdits && editDiffs.length > 0 && !signal?.aborted)
          {
            const verdict = await this.runEditVerification(
              userMessage,
              editDiffs,
              signal
            )
            if (verdict)
            {
              if (verdict.status !== 'pass') this.reliabilityStats.verifyFlags++

              // failed self-check: hand the reason back & let the model fix it,
              // bounded by the cap. unknown verdicts don't loop (no concrete
              // reason to act on) & a fresh verify reviews the fix on next finish
              const willRetry =
                verdict.status === 'fail' &&
                verifyReprompts < MAX_VERIFY_REPROMPTS &&
                !signal?.aborted
              verdict.retrying = willRetry
              events.onVerification?.(verdict)

              if (willRetry)
              {
                verifyReprompts++
                this.reliabilityStats.verifyReprompts++
                this.pushMessage({
                  role: 'user',
                  content: buildVerifyReprompt(verdict.reason),
                })
                continue
              }
            }
          }

          finish()
          return
        }

        // run parallel-safe tools in batches & keep approval flow serial
        // each call's index is its callId — correlates the result to its UI block
        const toolResults: OllamaMessage[] = []
        const roundBudget = toolResultBudget!
        let abortedDuringTools = false
        let toolIndex = 0

        while (toolIndex < toolCalls.length)
        {
          if (signal?.aborted)
          {
            abortedDuringTools = true
            break
          }

          const nextToolName = toolCalls[toolIndex]!.function.name

          if (
            this.canRunToolInParallel(
              nextToolName,
              toolCalls[toolIndex]!.function.arguments ?? {}
            )
          )
          {
            // collect a run of consecutive parallel-safe calls, each w/ a stable id
            const batch: ToolInvocation[] = []

            while (toolIndex < toolCalls.length)
            {
              const candidate = toolCalls[toolIndex]!
              if (
                !this.canRunToolInParallel(
                  candidate.function.name,
                  candidate.function.arguments ?? {}
                )
              )
              {
                break
              }

              batch.push({
                id: toolIndex,
                name: candidate.function.name,
                args: candidate.function.arguments ?? {},
              })
              toolIndex++
            }

            for (const item of batch)
            {
              events.onToolCall(
                item.name,
                item.args,
                item.id,
                this.mcpPresentation(item.name)
              )
            }

            // let parallel-safe tools finish the batch
            // so every announced call records a result (no dangling tool_calls on
            // abort); the post-loop check stops the run afterward
            let results: ToolResult[]
            try
            {
              results = await Promise.all(
                // parallel-eligible tools are always_allow & in-workspace (an
                // outside path forces require_approval, which can't batch here)
                batch.map((item) =>
                  this.executeTool(item.name, item.args, false, signal)
                )
              )
            }
            catch (err)
            {
              const errorMsg = `Parallel tool execution failed: ${toErrorMessage(err)}`
              for (const item of batch)
              {
                const trip = this.recordToolOutcome({
                  events,
                  toolResults,
                  roundBudget,
                  doomLoop,
                  editDiffs,
                  fileChanges,
                  todoChange,
                  invocation: item,
                  result: toolError(errorMsg),
                })
                if (trip && !doomTrip) doomTrip = trip
              }
              continue
            }

            for (const [index, result] of results.entries())
            {
              const item = batch[index]!
              const trip = this.recordToolOutcome({
                events,
                toolResults,
                roundBudget,
                doomLoop,
                editDiffs,
                fileChanges,
                todoChange,
                invocation: item,
                result,
              })
              if (trip && !doomTrip) doomTrip = trip
            }

            continue
          }

          const callId = toolIndex
          const call = toolCalls[toolIndex]!
          toolIndex++
          const toolName = call.function.name
          const toolArgs = call.function.arguments ?? {}
          const invocation: ToolInvocation = {
            id: callId,
            name: toolName,
            args: toolArgs,
          }
          events.onToolCall(
            toolName,
            toolArgs,
            callId,
            this.mcpPresentation(toolName)
          )

          const tool = this.getOwnTool(toolName)
          if (!tool)
          {
            const errorMsg = `Unknown tool: ${toolName}`
            const trip = this.recordToolOutcome({
              events,
              toolResults,
              roundBudget,
              doomLoop,
              editDiffs,
              fileChanges,
              todoChange,
              invocation,
              result: toolError(errorMsg),
            })
            if (trip && !doomTrip) doomTrip = trip
            continue
          }

          // resolve the workspace-crossing flag once — it drives both the
          // approval decision below & the execution context, so reuse it
          const crossesWorkspace = requiresWorkspacePathApproval(
            toolName,
            toolArgs,
            this.cwd
          )
          const policy = this.resolveInvocationPolicy(
            toolName,
            crossesWorkspace
          )

          if (policy === 'always_deny')
          {
            const deniedMsg = `Tool ${toolName} is denied by permission policy`
            this.recordToolOutcome({
              events,
              toolResults,
              roundBudget,
              doomLoop,
              editDiffs,
              fileChanges,
              todoChange,
              invocation,
              result: toolError(deniedMsg),
              trackDoom: false,
            })
            continue
          }

          if (policy === 'require_approval')
          {
            // race approval against abort signal
            let approved: boolean
            try
            {
              approved = await raceAbort(
                events.onToolApproval(
                  toolName,
                  toolArgs,
                  this.mcpPresentation(toolName)
                ),
                signal
              )
            }
            catch (err)
            {
              // record a result for the announced call so history stays consistent
              const errorMsg = signal?.aborted
                ? 'Tool call interrupted'
                : `Tool approval failed for ${toolName}: ${toErrorMessage(err)}`
              this.recordToolOutcome({
                events,
                toolResults,
                roundBudget,
                doomLoop,
                editDiffs,
                fileChanges,
                todoChange,
                invocation,
                result: toolError(errorMsg),
                trackDoom: false,
              })

              if (signal?.aborted)
              {
                abortedDuringTools = true
                break
              }
              continue
            }

            if (!approved)
            {
              const rejectedMsg = `Tool call rejected by user`
              this.recordToolOutcome({
                events,
                toolResults,
                roundBudget,
                doomLoop,
                editDiffs,
                fileChanges,
                todoChange,
                invocation,
                result: toolError(rejectedMsg),
                trackDoom: false,
              })
              continue
            }
          }

          const result = await this.executeTool(
            toolName,
            toolArgs,
            crossesWorkspace,
            signal
          )
          const trip = this.recordToolOutcome({
            events,
            toolResults,
            roundBudget,
            doomLoop,
            editDiffs,
            fileChanges,
            todoChange,
            invocation,
            result,
          })
          if (trip && !doomTrip) doomTrip = trip
        }

        // abort left later tool_calls unprocessed — record interrupted replies so
        // the persisted assistant message never has tool_calls w/o matching turns
        if (abortedDuringTools)
        {
          while (toolIndex < toolCalls.length)
          {
            const pending = toolCalls[toolIndex]!
            toolResults.push(
              this.buildToolMessage(
                pending.function.name,
                '',
                'Tool call interrupted',
                roundBudget
              )
            )
            toolIndex++
          }
        }

        if (
          toolResults.length !== toolCalls.length ||
          roundBudget.remainingCalls !== 0
        )
        {
          fail(new Error('Tool-result round did not settle every model call'))
          return
        }

        // stage the assistant call & all matching results as one protected round;
        // the exact no-Git continuation must fit before any of it enters history
        const projectedRound = this.buildRequestBudget(
          [...this.state.getMessages(), assistantMessage, ...toolResults].map(
            toModelRequestMessage
          ),
          null,
          runAnchor,
          userMessage
        )
        if (!projectedRound.fits)
        {
          this.lastRequestBudget = projectedRound
          try
          {
            assertRequestBudget(projectedRound)
          }
          catch (err)
          {
            fail(toError(err))
          }
          return
        }
        this.pushMessage(assistantMessage)
        this.pushMessages(toolResults)

        if (abortedDuringTools)
        {
          finish()
          return
        }

        // doom-loop guard: the window shows a stuck pattern — pause & ask the user
        // whether to continue (interactive runs only; subagents rely on the cap)
        if (doomTrip && events.onDoomLoop)
        {
          this.reliabilityStats.doomLoopTrips++
          let proceed: boolean
          try
          {
            proceed = await raceAbort(
              events.onDoomLoop(describeDoomLoop(doomTrip)),
              signal
            )
          }
          catch
          {
            finish()
            return
          }

          if (!proceed)
          {
            finish()
            return
          }
          // fresh streak required before tripping again
          doomLoop.reset()
        }
      }
    }
    catch (err)
    {
      // callbacks are host code too. if one escapes before a terminal signal,
      // report it through the normal failure channel after releasing ownership.
      // a terminal callback that itself throws is propagated exactly once.
      if (terminalCallbackStarted) throw err
      if (signal.aborted || this.lifecycleAbort.signal.aborted)
      {
        finish()
        return
      }
      fail(toError(err))
    }
    finally
    {
      // every exit path owns this accepted turn until here, including callback
      // failures & internal exceptions outside the localized stream guards
      finalize()
      this.clearCompactionCallbacks()
    }
  }
}
