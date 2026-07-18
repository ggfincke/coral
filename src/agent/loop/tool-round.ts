// src/agent/loop/tool-round.ts
// execute one bounded tool-call round and collect its effects

import type { ToolPermissions } from '../../config/permissions.js'
import { getToolPolicy } from '../../config/permissions.js'
import type { CodeIntelService } from '../../lsp/contracts.js'
import type { ToolCatalog } from '../../tools/catalog.js'
import { requiresWorkspacePathApproval } from '../../tools/path-policy.js'
import type { SubagentRunner } from '../../tools/subagent.js'
import { capErrorMessage } from '../../tools/tool-output.js'
import type { ToolExecutionContext, ToolResult } from '../../tools/tool.js'
import { validateToolArgs } from '../../tools/validation.js'
import type { OllamaMessage, OllamaToolCall } from '../../types/inference.js'
import { cloneTodoItems, type TodoState } from '../../types/todo.js'
import type { UndoFileChange, UndoTodoChange } from '../../types/undo.js'
import { raceAbort } from '../../utils/abort.js'
import {
  trimLeadingLowSurrogate,
  trimTrailingHighSurrogate,
} from '../../utils/ellipsize.js'
import { toError, toErrorMessage } from '../../utils/errors.js'
import {
  MAX_TOOL_OUTPUT_CHARS,
  estimateUtf8Tokens,
} from '../../utils/limits.js'
import { normalizeToolName } from '../../utils/tool-name.js'
import type { AgentEvents } from '../contracts.js'
import type { DoomLoopDetector, DoomLoopTrip } from './doom-loop.js'
import { estimateModelRequestMessageTokens } from '../request/projection.js'

// bound echoed arguments without changing the full invocation sent to tools
const MAX_STORED_TOOL_ARGUMENT_TOKENS = 2_048
const TOOL_RESULT_OMITTED = '[tool result omitted to fit request budget]'
const TOOL_RESULT_REDACTED_OMITTED =
  '[tool result omitted to fit request budget; redacted content was present]'

declare const preparedToolRoundBrand: unique symbol

export interface ToolRoundExecutorOptions
{
  cwd: string
  ollamaHost: string
  permissions: ToolPermissions
  subagentRunner: SubagentRunner
  codeIntel: CodeIntelService
  todoState: TodoState
}

export interface PreparedToolRound
{
  readonly [preparedToolRoundBrand]: true
  readonly calls: readonly OllamaToolCall[]
  readonly storedCalls: readonly OllamaToolCall[]
  readonly minimumResultMessages: readonly OllamaMessage[]
  readonly nameRepairs: number
}

export interface ToolResultRoundAllowance
{
  readonly minimumTokens: readonly number[]
  readonly remainingTokens: number
}

export interface ToolRoundEffects
{
  readonly editDiffs: readonly string[]
  readonly fileChanges: readonly UndoFileChange[]
  readonly todoChange?: UndoTodoChange
}

export interface ToolRoundReliabilityDelta
{
  readonly validationFailures: number
  readonly editRepairs: number
}

export interface ToolRoundOutcome
{
  readonly toolResults: readonly OllamaMessage[]
  readonly effects: ToolRoundEffects
  readonly reliability: ToolRoundReliabilityDelta
  readonly doomTrip: DoomLoopTrip | null
  readonly aborted: boolean
}

export type ToolRoundExecution =
  | {
      status: 'settled'
      outcome: ToolRoundOutcome
    }
  | {
      status: 'failed'
      error: Error
      outcome: ToolRoundOutcome
    }

export type ToolRoundEvents = Pick<
  AgentEvents,
  'onToolCall' | 'onToolResult' | 'onToolApproval'
>

interface PreparedToolRoundRecord
{
  owner: ToolRoundExecutor
  catalog: ToolCatalog
}

interface ToolInvocation
{
  id: number
  name: string
  args: Record<string, unknown>
  presentation: ReturnType<ToolCatalog['presentationFor']>
}

interface MutableToolResultRoundBudget
{
  minimumTokens: readonly number[]
  nextResult: number
  remainingCalls: number
  remainingMinimumTokens: number
  remainingTokens: number
}

interface MutableToolRoundOutcome
{
  toolResults: OllamaMessage[]
  effects: {
    editDiffs: string[]
    fileChanges: UndoFileChange[]
    todoChange?: UndoTodoChange
  }
  reliability: {
    validationFailures: number
    editRepairs: number
  }
  doomTrip: DoomLoopTrip | null
  aborted: boolean
}

const preparedToolRounds = new WeakMap<
  PreparedToolRound,
  PreparedToolRoundRecord
>()

function toolError(error: string): ToolResult
{
  return { output: '', error }
}

function cloneFrozenJson<T>(value: T): T
{
  if (Array.isArray(value))
  {
    return Object.freeze(value.map((item) => cloneFrozenJson(item))) as T
  }
  if (typeof value === 'object' && value !== null)
  {
    const clone = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneFrozenJson(item)])
    )
    return Object.freeze(clone) as T
  }
  return value
}

function frozenToolCall(
  call: OllamaToolCall,
  name = call.function.name
): OllamaToolCall
{
  const fn = Object.freeze({
    ...(call.function.index === undefined
      ? {}
      : { index: call.function.index }),
    name,
    arguments: cloneFrozenJson(call.function.arguments),
  })
  return Object.freeze({
    ...(call.type === undefined ? {} : { type: call.type }),
    function: fn,
  })
}

function storedToolCall(call: OllamaToolCall): OllamaToolCall
{
  const serialized = JSON.stringify(call.function.arguments)
  if (
    estimateUtf8Tokens(serialized).tokens <= MAX_STORED_TOOL_ARGUMENT_TOKENS
  )
  {
    return frozenToolCall(call)
  }

  return frozenToolCall({
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
  })
}

function minimumToolResultMessage(toolName: string): OllamaMessage
{
  return Object.freeze({
    role: 'tool',
    tool_name: toolName,
    content: `Error: ${TOOL_RESULT_REDACTED_OMITTED}`,
  })
}

function emptyOutcome(): MutableToolRoundOutcome
{
  return {
    toolResults: [],
    effects: {
      editDiffs: [],
      fileChanges: [],
    },
    reliability: {
      validationFailures: 0,
      editRepairs: 0,
    },
    doomTrip: null,
    aborted: false,
  }
}

function isolatedOutcome(outcome: MutableToolRoundOutcome): ToolRoundOutcome
{
  const todoChange = outcome.effects.todoChange
  const toolResults = Object.freeze(
    outcome.toolResults.map((message) => cloneFrozenJson(message))
  )
  const effects = Object.freeze({
    editDiffs: Object.freeze([...outcome.effects.editDiffs]),
    fileChanges: Object.freeze(
      outcome.effects.fileChanges.map((change) => Object.freeze({ ...change }))
    ),
    ...(todoChange
      ? {
          todoChange: Object.freeze({
            before: cloneFrozenJson(cloneTodoItems(todoChange.before)),
            after: cloneFrozenJson(cloneTodoItems(todoChange.after)),
          }),
        }
      : {}),
  })
  return Object.freeze({
    toolResults,
    effects,
    reliability: Object.freeze({ ...outcome.reliability }),
    doomTrip: outcome.doomTrip ? Object.freeze({ ...outcome.doomTrip }) : null,
    aborted: outcome.aborted,
  })
}

// coordinate one exact catalog snapshot without owning conversation history
export class ToolRoundExecutor
{
  private readonly cwd: string
  private readonly ollamaHost: string
  private readonly permissions: ToolPermissions
  private readonly subagentRunner: SubagentRunner
  private readonly codeIntel: CodeIntelService
  private readonly todoState: TodoState

  constructor(options: ToolRoundExecutorOptions)
  {
    this.cwd = options.cwd
    this.ollamaHost = options.ollamaHost
    this.permissions = options.permissions
    this.subagentRunner = options.subagentRunner
    this.codeIntel = options.codeIntel
    this.todoState = options.todoState
  }

  prepare(
    toolCalls: readonly OllamaToolCall[],
    catalog: ToolCatalog
  ): PreparedToolRound
  {
    let nameRepairs = 0
    const calls = toolCalls.map((call) =>
    {
      const name = call.function.name
      if (catalog.has(name)) return frozenToolCall(call)

      const normalized = normalizeToolName(name)
      const match = catalog.tools.find(
        (tool) => normalizeToolName(tool.name) === normalized
      )
      if (!match) return frozenToolCall(call)

      nameRepairs++
      return frozenToolCall(call, match.name)
    })
    const frozenCalls = Object.freeze(calls)
    const storedCalls = Object.freeze(frozenCalls.map(storedToolCall))
    const minimumResultMessages = Object.freeze(
      frozenCalls.map((call) => minimumToolResultMessage(call.function.name))
    )

    const prepared = Object.freeze({
      calls: frozenCalls,
      storedCalls,
      minimumResultMessages,
      nameRepairs,
    }) as PreparedToolRound
    preparedToolRounds.set(prepared, { owner: this, catalog })
    return prepared
  }

  async execute(input: {
    round: PreparedToolRound
    allowance: ToolResultRoundAllowance
    events: ToolRoundEvents
    doomLoop: DoomLoopDetector
    signal?: AbortSignal
  }): Promise<ToolRoundExecution>
  {
    const outcome = emptyOutcome()

    try
    {
      const record = preparedToolRounds.get(input.round)
      preparedToolRounds.delete(input.round)
      if (record?.owner !== this)
      {
        throw new Error('Tool round was not prepared by this executor')
      }
      if (input.allowance.minimumTokens.length !== input.round.calls.length)
      {
        throw new Error('Tool-result allowance does not cover every model call')
      }

      const minimumTokens = [...input.allowance.minimumTokens]
      if (
        minimumTokens.some(
          (tokens) => !Number.isSafeInteger(tokens) || tokens < 0
        ) ||
        !Number.isSafeInteger(input.allowance.remainingTokens)
      )
      {
        throw new Error('Tool-result allowance must contain whole token counts')
      }
      const expectedMinimumTokens = input.round.minimumResultMessages.map(
        estimateModelRequestMessageTokens
      )
      if (
        minimumTokens.some(
          (tokens, index) => tokens !== expectedMinimumTokens[index]
        )
      )
      {
        throw new Error(
          'Tool-result allowance does not match the prepared minimum replies'
        )
      }
      const remainingMinimumTokens = minimumTokens.reduce(
        (total, tokens) => total + tokens,
        0
      )
      if (input.allowance.remainingTokens < remainingMinimumTokens)
      {
        throw new Error(
          'Tool-result allowance cannot fit every reserved minimum reply'
        )
      }

      const budget: MutableToolResultRoundBudget = {
        minimumTokens,
        nextResult: 0,
        remainingCalls: input.round.calls.length,
        remainingMinimumTokens,
        remainingTokens: input.allowance.remainingTokens,
      }

      await this.dispatch({
        calls: input.round.calls,
        catalog: record.catalog,
        budget,
        events: input.events,
        doomLoop: input.doomLoop,
        signal: input.signal,
        outcome,
      })

      if (
        outcome.toolResults.length !== input.round.calls.length ||
        budget.remainingCalls !== 0
      )
      {
        throw new Error('Tool-result round did not settle every model call')
      }

      return { status: 'settled', outcome: isolatedOutcome(outcome) }
    }
    catch (error)
    {
      return {
        status: 'failed',
        error: toError(error),
        outcome: isolatedOutcome(outcome),
      }
    }
  }

  private async dispatch(input: {
    calls: readonly OllamaToolCall[]
    catalog: ToolCatalog
    budget: MutableToolResultRoundBudget
    events: ToolRoundEvents
    doomLoop: DoomLoopDetector
    signal?: AbortSignal
    outcome: MutableToolRoundOutcome
  }): Promise<void>
  {
    let toolIndex = 0

    while (toolIndex < input.calls.length)
    {
      if (input.signal?.aborted)
      {
        input.outcome.aborted = true
        break
      }

      const next = input.calls[toolIndex]!
      if (
        this.canRunToolInParallel(
          input.catalog,
          next.function.name,
          next.function.arguments ?? {}
        )
      )
      {
        const batch: ToolInvocation[] = []
        while (toolIndex < input.calls.length)
        {
          const candidate = input.calls[toolIndex]!
          const args = candidate.function.arguments ?? {}
          if (
            !this.canRunToolInParallel(
              input.catalog,
              candidate.function.name,
              args
            )
          )
          {
            break
          }

          batch.push(
            this.invocation(
              input.catalog,
              toolIndex,
              candidate.function.name,
              args
            )
          )
          toolIndex++
        }

        for (const item of batch)
        {
          input.events.onToolCall(
            item.name,
            item.args,
            item.id,
            item.presentation
          )
        }

        let results: ToolResult[]
        try
        {
          results = await Promise.all(
            batch.map((item) =>
              this.executeTool(
                input.catalog,
                item.name,
                item.args,
                false,
                input.outcome,
                input.signal
              )
            )
          )
        }
        catch (error)
        {
          const message = `Parallel tool execution failed: ${toErrorMessage(error)}`
          results = batch.map(() => toolError(message))
        }

        const completed = results.map((result, index) => ({
          invocation: batch[index]!,
          result,
        }))
        // stage every completed mutation before host callbacks can throw
        for (const item of completed)
        {
          this.stageToolOutcome({
            invocation: item.invocation,
            result: item.result,
            budget: input.budget,
            doomLoop: input.doomLoop,
            outcome: input.outcome,
          })
        }
        for (const item of completed)
        {
          this.emitToolOutcome(input.events, item.invocation, item.result)
        }
        continue
      }

      const call = input.calls[toolIndex]!
      const invocation = this.invocation(
        input.catalog,
        toolIndex,
        call.function.name,
        call.function.arguments ?? {}
      )
      toolIndex++
      input.events.onToolCall(
        invocation.name,
        invocation.args,
        invocation.id,
        invocation.presentation
      )

      const tool = input.catalog.get(invocation.name)
      if (!tool)
      {
        this.recordToolOutcome({
          invocation,
          result: toolError(`Unknown tool: ${invocation.name}`),
          budget: input.budget,
          events: input.events,
          doomLoop: input.doomLoop,
          outcome: input.outcome,
        })
        continue
      }

      const crossesWorkspace = requiresWorkspacePathApproval(
        invocation.name,
        invocation.args,
        this.cwd
      )
      const policy = this.resolveInvocationPolicy(
        invocation.name,
        crossesWorkspace
      )

      if (policy === 'always_deny')
      {
        this.recordToolOutcome({
          invocation,
          result: toolError(
            `Tool ${invocation.name} is denied by permission policy`
          ),
          budget: input.budget,
          events: input.events,
          doomLoop: input.doomLoop,
          outcome: input.outcome,
          trackDoom: false,
        })
        continue
      }

      if (policy === 'require_approval')
      {
        let approved: boolean
        try
        {
          approved = await raceAbort(
            input.events.onToolApproval(
              invocation.name,
              invocation.args,
              invocation.presentation
            ),
            input.signal
          )
        }
        catch (error)
        {
          const message = input.signal?.aborted
            ? 'Tool call interrupted'
            : `Tool approval failed for ${invocation.name}: ${toErrorMessage(error)}`
          this.recordToolOutcome({
            invocation,
            result: toolError(message),
            budget: input.budget,
            events: input.events,
            doomLoop: input.doomLoop,
            outcome: input.outcome,
            trackDoom: false,
          })

          if (input.signal?.aborted)
          {
            input.outcome.aborted = true
            break
          }
          continue
        }

        if (!approved)
        {
          this.recordToolOutcome({
            invocation,
            result: toolError('Tool call rejected by user'),
            budget: input.budget,
            events: input.events,
            doomLoop: input.doomLoop,
            outcome: input.outcome,
            trackDoom: false,
          })
          continue
        }
      }

      const result = await this.executeTool(
        input.catalog,
        invocation.name,
        invocation.args,
        crossesWorkspace,
        input.outcome,
        input.signal
      )
      this.recordToolOutcome({
        invocation,
        result,
        budget: input.budget,
        events: input.events,
        doomLoop: input.doomLoop,
        outcome: input.outcome,
      })
    }

    if (input.signal?.aborted) input.outcome.aborted = true
    if (!input.outcome.aborted) return

    while (toolIndex < input.calls.length)
    {
      const pending = input.calls[toolIndex]!
      input.outcome.toolResults.push(
        this.buildToolMessage(
          pending.function.name,
          '',
          'Tool call interrupted',
          input.budget
        )
      )
      toolIndex++
    }
  }

  private invocation(
    catalog: ToolCatalog,
    id: number,
    name: string,
    args: Record<string, unknown>
  ): ToolInvocation
  {
    return {
      id,
      name,
      args,
      presentation: catalog.presentationFor(name, args),
    }
  }

  private resolveInvocationPolicy(
    toolName: string,
    crossesWorkspace: boolean
  ): ToolPermissions[string]
  {
    const policy = getToolPolicy(this.permissions, toolName)
    return policy === 'always_allow' && crossesWorkspace
      ? 'require_approval'
      : policy
  }

  private canRunToolInParallel(
    catalog: ToolCatalog,
    toolName: string,
    args: Record<string, unknown>
  ): boolean
  {
    return (
      catalog.getProfile(toolName)?.parallelSafe === true &&
      this.resolveInvocationPolicy(
        toolName,
        requiresWorkspacePathApproval(toolName, args, this.cwd)
      ) === 'always_allow'
    )
  }

  private buildToolExecutionContext(
    allowOutsideWorkspace: boolean,
    signal?: AbortSignal
  ): ToolExecutionContext
  {
    return {
      cwd: this.cwd,
      ollamaHost: this.ollamaHost,
      allowOutsideWorkspace,
      subagentRunner: this.subagentRunner,
      codeIntel: this.codeIntel,
      todoState: this.todoState,
      signal,
    }
  }

  private async executeTool(
    catalog: ToolCatalog,
    toolName: string,
    toolArgs: Record<string, unknown>,
    allowOutsideWorkspace: boolean,
    outcome: MutableToolRoundOutcome,
    signal?: AbortSignal
  ): Promise<ToolResult>
  {
    try
    {
      const tool = catalog.get(toolName)!
      const validation = validateToolArgs(tool, toolArgs)
      if (!validation.ok)
      {
        outcome.reliability.validationFailures++
        return toolError(validation.error)
      }

      const result = await tool.execute(
        validation.args,
        this.buildToolExecutionContext(allowOutsideWorkspace, signal)
      )
      if (result.repaired) outcome.reliability.editRepairs++
      return result
    }
    catch (error)
    {
      return toolError(
        `Tool execution failed for ${toolName}: ${toErrorMessage(error)}`
      )
    }
  }

  private buildToolMessage(
    toolName: string,
    output: string,
    error: string | undefined,
    budget: MutableToolResultRoundBudget
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
    const minimumTokens = budget.minimumTokens[budget.nextResult]
    if (minimumTokens === undefined || budget.remainingCalls <= 0)
    {
      throw new Error('Tool-result round budget consumed out of order')
    }

    const extraTokens = Math.max(
      budget.remainingTokens - budget.remainingMinimumTokens,
      0
    )
    const maxTokens =
      minimumTokens + Math.floor(extraTokens / budget.remainingCalls)
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
    budget.remainingTokens -= usedTokens
    budget.remainingMinimumTokens -= minimumTokens
    budget.remainingCalls--
    budget.nextResult++
    return message
  }

  private recordToolOutcome(input: {
    invocation: ToolInvocation
    result: ToolResult
    budget: MutableToolResultRoundBudget
    events: ToolRoundEvents
    doomLoop: DoomLoopDetector
    outcome: MutableToolRoundOutcome
    trackDoom?: boolean
  }): void
  {
    this.stageToolOutcome(input)
    this.emitToolOutcome(input.events, input.invocation, input.result)
  }

  private stageToolOutcome(input: {
    invocation: ToolInvocation
    result: ToolResult
    budget: MutableToolResultRoundBudget
    doomLoop: DoomLoopDetector
    outcome: MutableToolRoundOutcome
    trackDoom?: boolean
  }): void
  {
    input.outcome.toolResults.push(
      this.buildToolMessage(
        input.invocation.name,
        input.result.output,
        input.result.error,
        input.budget
      )
    )
    if (input.result.diff)
    {
      input.outcome.effects.editDiffs.push(input.result.diff)
    }
    if (input.result.change)
    {
      input.outcome.effects.fileChanges.push({ ...input.result.change })
    }
    if (input.result.todoChange)
    {
      const current = input.outcome.effects.todoChange
      if (current)
      {
        current.after = cloneTodoItems(input.result.todoChange.after)
      }
      else
      {
        input.outcome.effects.todoChange = {
          before: cloneTodoItems(input.result.todoChange.before),
          after: cloneTodoItems(input.result.todoChange.after),
        }
      }
    }

    const trip =
      input.trackDoom === false
        ? null
        : input.doomLoop.record(
            input.invocation.name,
            input.invocation.args,
            input.result.error
          )
    if (trip && !input.outcome.doomTrip) input.outcome.doomTrip = trip
  }

  private emitToolOutcome(
    events: ToolRoundEvents,
    invocation: ToolInvocation,
    result: ToolResult
  ): void
  {
    events.onToolResult(
      invocation.name,
      result.output,
      result.error,
      invocation.id,
      result.diff
    )
  }
}
