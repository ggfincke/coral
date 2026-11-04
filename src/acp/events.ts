// src/acp/events.ts
// project Coral run callbacks into ordered ACP session updates

import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type {
  AgentContext,
  SessionUpdate,
  ToolCallUpdate,
  ToolKind,
  Usage,
} from '@agentclientprotocol/sdk/unstable'
import { methods } from '@agentclientprotocol/sdk/unstable'
import type { AgentEvents } from '../agent/contracts.js'
import type { ToolCallPresentation } from '../tools/tool.js'
import type { SessionCostSnapshot } from '../types/session-cost.js'
import type { TodoItem } from '../types/todo.js'
import { truncateToLineBoundary } from '../utils/truncate-output.js'
import {
  sanitizeUntrustedText,
  stringifyForDisplay,
} from '../utils/untrusted-text.js'
import {
  runtimeModeAutoApproves,
  type CoralRuntimeMode,
} from './session-policy.js'

const MAX_TOOL_OUTPUT_CHARS = 32_768
const MAX_TOOL_TITLE_CHARS = 240

interface ActiveToolCall
{
  acpId: string
  args: Record<string, unknown>
  name: string
  presentation?: ToolCallPresentation
  permissionRequested: boolean
}

export interface AcpEventProjectionOptions
{
  sessionId: string
  cwd: string
  client: AgentContext
  signal: AbortSignal
  isCurrent: () => boolean
  getTodos: () => TodoItem[]
  getContextWindow: () => number
  getSessionCost?: () => SessionCostSnapshot | undefined
  // read at each approval so a mid-turn mode change applies to the next call
  getRuntimeMode: () => CoralRuntimeMode
  // in-memory allow-always grants owned by the session binding
  sessionToolGrants: Set<string>
}

export class AcpIdAllocator
{
  private readonly instanceId = randomUUID()
  private nextValue = 0

  constructor(private readonly sessionId: string)
  {}

  next(kind: 'message' | 'thought' | 'tool'): string
  {
    this.nextValue += 1
    return `${this.sessionId}:${this.instanceId}:${kind}:${this.nextValue}`
  }
}

function toolKind(name: string): ToolKind
{
  if (['grep', 'glob', 'search_code'].includes(name)) return 'search'
  if (['write_file', 'edit_file'].includes(name)) return 'edit'
  if (name === 'bash') return 'execute'
  if (name === 'task') return 'think'
  if (
    [
      'read_file',
      'list_files',
      'code_intel',
      'git_status',
      'git_diff',
      'git_log',
    ].includes(name)
  )
  {
    return 'read'
  }
  return 'other'
}

function toolTitle(name: string, presentation?: ToolCallPresentation): string
{
  const label = presentation?.label || name
  const title = presentation?.summary
    ? `${label}: ${presentation.summary}`
    : label
  return sanitizeUntrustedText(title).slice(0, MAX_TOOL_TITLE_CHARS)
}

function toolLocation(
  cwd: string,
  args: Record<string, unknown>
): Array<{ path: string }> | undefined
{
  const candidate = [args.path, args.file_path].find(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
  if (!candidate) return undefined
  return [{ path: isAbsolute(candidate) ? candidate : resolve(cwd, candidate) }]
}

function boundedToolOutput(output: string): string
{
  const sanitized = sanitizeUntrustedText(output)
  const truncated = truncateToLineBoundary(sanitized, MAX_TOOL_OUTPUT_CHARS)
  if (!truncated.truncated) return truncated.head
  return `${truncated.head}\n\n[${truncated.omitted} characters omitted]`
}

function toolInput(call: ActiveToolCall): Record<string, unknown>
{
  return {
    toolName: call.name,
    arguments: call.args,
    // ACP clients read shell commands directly from rawInput.command
    ...(call.name === 'bash' && typeof call.args.command === 'string'
      ? { command: call.args.command }
      : {}),
  }
}

function permissionToolCall(call: ActiveToolCall): ToolCallUpdate
{
  return {
    toolCallId: call.acpId,
    kind: toolKind(call.name),
    status: 'pending',
    title: toolTitle(call.name, call.presentation),
    rawInput: toolInput(call),
  }
}

export class AcpEventProjection
{
  private readonly tools = new Map<number, ActiveToolCall>()
  private notificationTail: Promise<void> = Promise.resolve()
  private assistantMessageId?: string
  private thoughtMessageId?: string
  private latestUsage?: Usage
  private promptInputTokens = 0
  private promptOutputTokens = 0
  private promptCachedReadTokens?: number
  private promptCachedWriteTokens?: number
  private agentError?: Error
  private iterationLimited = false

  constructor(
    private readonly options: AcpEventProjectionOptions,
    private readonly ids: AcpIdAllocator
  )
  {}

  private enqueue(update: SessionUpdate): void
  {
    this.notificationTail = this.notificationTail.then(async () =>
    {
      if (!this.options.isCurrent()) return
      await this.options.client.notify(methods.client.session.update, {
        sessionId: this.options.sessionId,
        update,
      })
    })
    // observe failures immediately while retaining the rejection for drain
    void this.notificationTail.catch(() =>
    {})
  }

  private resetMessageSegments(): void
  {
    this.assistantMessageId = undefined
    this.thoughtMessageId = undefined
  }

  private async requestToolApproval(
    name: string,
    args: Record<string, unknown>,
    callId: number | undefined,
    crossesWorkspace: boolean
  ): Promise<boolean>
  {
    if (callId === undefined) return false
    const call = this.tools.get(callId)
    if (!call || !this.options.isCurrent()) return false
    if (
      call.name !== name ||
      stringifyForDisplay(call.args) !== stringifyForDisplay(args)
    )
    {
      return false
    }
    if (call.permissionRequested) return false
    call.permissionRequested = true
    // auto-approved calls skip only the prompt; tool_call & its update still flow
    if (
      this.options.sessionToolGrants.has(name) ||
      runtimeModeAutoApproves(
        this.options.getRuntimeMode(),
        name,
        crossesWorkspace
      )
    )
    {
      return true
    }
    await this.drain()
    if (!this.options.isCurrent()) return false

    const allowId = `${call.acpId}:allow-once`
    const alwaysId = `${call.acpId}:allow-always`
    const rejectId = `${call.acpId}:reject-once`
    const response = await this.options.client.request(
      methods.client.session.requestPermission,
      {
        sessionId: this.options.sessionId,
        toolCall: permissionToolCall(call),
        options: [
          {
            optionId: allowId,
            name: 'Allow once',
            kind: 'allow_once',
          },
          {
            optionId: alwaysId,
            name: 'Always allow this session',
            kind: 'allow_always',
          },
          {
            optionId: rejectId,
            name: 'Reject once',
            kind: 'reject_once',
          },
        ],
      },
      { cancellationSignal: this.options.signal }
    )
    if (!this.options.isCurrent()) return false
    if (response.outcome.outcome !== 'selected') return false
    // like the TUI's (a), the grant covers the tool name w/ any arguments,
    // including outside-workspace paths, until the binding is released
    if (response.outcome.optionId === alwaysId)
    {
      this.options.sessionToolGrants.add(name)
      return true
    }
    return response.outcome.optionId === allowId
  }

  private emitPlan(): void
  {
    this.enqueue({
      sessionUpdate: 'plan',
      entries: this.options.getTodos().map((todo) => ({
        content: todo.content,
        priority: 'medium',
        status: todo.status,
      })),
    })
  }

  events(): AgentEvents
  {
    return {
      onToken: (token) =>
      {
        this.thoughtMessageId = undefined
        this.assistantMessageId ??= this.ids.next('message')
        this.enqueue({
          sessionUpdate: 'agent_message_chunk',
          messageId: this.assistantMessageId,
          content: { type: 'text', text: token },
        })
      },
      onThinking: (thinking) =>
      {
        this.assistantMessageId = undefined
        this.thoughtMessageId ??= this.ids.next('thought')
        this.enqueue({
          sessionUpdate: 'agent_thought_chunk',
          messageId: this.thoughtMessageId,
          content: { type: 'text', text: thinking },
        })
      },
      onToolCall: (name, args, callId, presentation) =>
      {
        this.resetMessageSegments()
        const call: ActiveToolCall = {
          acpId: this.ids.next('tool'),
          args,
          name,
          presentation,
          permissionRequested: false,
        }
        this.tools.set(callId, call)
        this.enqueue({
          sessionUpdate: 'tool_call',
          toolCallId: call.acpId,
          title: toolTitle(name, presentation),
          kind: toolKind(name),
          status: 'pending',
          locations: toolLocation(this.options.cwd, args),
          rawInput: toolInput(call),
        })
      },
      onToolResult: (name, result, error, callId, diff) =>
      {
        this.resetMessageSegments()
        const call = this.tools.get(callId)
        const toolCallId = call?.acpId ?? this.ids.next('tool')
        const output = boundedToolOutput(error ? `${error}\n${result}` : result)
        this.enqueue({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: error ? 'failed' : 'completed',
          content: output
            ? [{ type: 'content', content: { type: 'text', text: output } }]
            : undefined,
          rawOutput: {
            output,
            ...(error ? { error: boundedToolOutput(error) } : {}),
            ...(diff ? { diff: boundedToolOutput(diff) } : {}),
          },
        })
        this.tools.delete(callId)
        if (name === 'todo_write') this.emitPlan()
      },
      onToolApproval: (name, args, _presentation, callId, crossesWorkspace) =>
        this.requestToolApproval(
          name,
          args,
          callId,
          // fail closed: only an explicit in-workspace call can auto-accept edits
          crossesWorkspace !== false
        ),
      onMcpLaunchApproval: async () => false,
      onDoomLoop: async () => false,
      onUsage: (usage) =>
      {
        this.promptInputTokens += usage.promptTokens
        this.promptOutputTokens += usage.completionTokens
        if (usage.cachedPromptTokens !== undefined)
          this.promptCachedReadTokens =
            (this.promptCachedReadTokens ?? 0) + usage.cachedPromptTokens
        if (usage.cacheWriteTokens !== undefined)
          this.promptCachedWriteTokens =
            (this.promptCachedWriteTokens ?? 0) + usage.cacheWriteTokens
        this.latestUsage = {
          totalTokens: this.promptInputTokens + this.promptOutputTokens,
          inputTokens: this.promptInputTokens,
          outputTokens: this.promptOutputTokens,
          ...(this.promptCachedReadTokens !== undefined
            ? { cachedReadTokens: this.promptCachedReadTokens }
            : {}),
          ...(this.promptCachedWriteTokens !== undefined
            ? { cachedWriteTokens: this.promptCachedWriteTokens }
            : {}),
        }
        const size = this.options.getContextWindow()
        if (size <= 0) return
        const costs = this.options.getSessionCost?.()
        // ACP cannot mark partial estimates, so omit an incomplete session total
        const knownCost =
          costs &&
          !costs.historicalUsageUnknown &&
          costs.entries.length > 0 &&
          costs.entries.every(
            (entry) =>
              entry.unpricedRequests === 0 && entry.missingUsageRequests === 0
          )
        this.enqueue({
          sessionUpdate: 'usage_update',
          used: Math.min(Math.max(usage.contextTokens, 0), size),
          size,
          ...(knownCost
            ? {
                cost: {
                  amount: costs.entries.reduce(
                    (sum, entry) => sum + entry.usd,
                    0
                  ),
                  currency: 'USD',
                },
              }
            : {}),
        })
      },
      onIterationLimit: () =>
      {
        this.iterationLimited = true
      },
      onDone: () =>
      {},
      onError: (error) =>
      {
        this.agentError = error
      },
    }
  }

  hitIterationLimit(): boolean
  {
    return this.iterationLimited
  }

  getUsage(): Usage | undefined
  {
    return this.latestUsage ? { ...this.latestUsage } : undefined
  }

  getAgentError(): Error | undefined
  {
    return this.agentError
  }

  async drain(): Promise<void>
  {
    await this.notificationTail
  }
}
