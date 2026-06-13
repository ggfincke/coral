// src/agent/agent.ts
// conversation loop w/ tool-use cycling

import { OllamaClient } from '../ollama/client.js'
import type {
  OllamaMessage,
  OllamaToolCall,
  OllamaTool,
} from '../types/inference.js'
import {
  allTools,
  subagentTools,
  toolToOllamaFormat,
  type Tool,
  type ToolResult,
} from '../tools/index.js'
import { setSubagentRunner, type SubagentResult } from '../tools/subagent.js'
import { setOllamaHost } from '../ollama/host.js'
import { buildSystemPrompt } from './system-prompt.js'
import { setCwd, getCwd } from '../cwd.js'
import {
  resolvePermissions,
  getToolPolicy,
  type ToolPermissions,
} from '../config/permissions.js'
import {
  estimateMessageTokens,
  estimateTotalTokens,
  shouldPrune,
  shouldCompactByTotal,
  splitForCompaction,
  buildCompactionPrompt,
  buildCompactedMessages,
  pruneToolResults,
  stripThinkingForCompaction,
  countFrozenPrefix,
  MAX_COMPACT_FAILURES,
  MAX_FROZEN_SUMMARIES,
  type CompactionConfig,
  type CompactionResult,
  DEFAULT_COMPACTION_CONFIG,
} from './compaction.js'
import { resolveContextConfig } from '../config/context.js'

export type { CompactionResult } from './compaction.js'
import { toError } from '../utils/errors.js'
import { capToolOutput } from './tool-output.js'
import {
  parseToolCallsFromContent,
  STALL_NUDGE_MESSAGE,
  MAX_STALL_NUDGES,
  normalizeToolName,
} from './repair.js'
import { validateToolArgs } from './tool-validation.js'

// max messages to keep in history (system prompt + recent context)
const MAX_HISTORY = 100

// cap tool-call rounds for a research subagent so it can't loop unbounded
const SUBAGENT_MAX_ITERATIONS = 24

const COMPACTION_SYSTEM_PROMPT =
  'You are a helpful assistant. Produce a concise structured summary of the conversation.'

interface ToolInvocation
{
  id: number
  name: string
  args: Record<string, unknown>
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

// race a promise against an AbortSignal — rejects w/ AbortError if aborted first
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T>
{
  if (!signal) return promise
  if (signal.aborted)
    return Promise.reject(new DOMException('Aborted', 'AbortError'))

  return new Promise<T>((resolve, reject) =>
  {
    const onAbort = () =>
    {
      reject(new DOMException('Aborted', 'AbortError'))
    }

    signal.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (value) =>
      {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) =>
      {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

// reliability-layer counters — how often the agent had to compensate for the
// model botching a tool call (per-model telemetry for /status)
export interface ReliabilityStats
{
  repairedToolCalls: number
  nameRepairs: number
  stallNudges: number
  validationFailures: number
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
    callId: number
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
    args: Record<string, unknown>
  ) => Promise<boolean>
  onUsage?: (usage: TokenUsage) => void
  // fires before a summarization model call starts (so the TUI can show status)
  onCompactionStart?: () => void
  // fires after a prune or summarize completes w/ stats
  onCompaction?: (result: CompactionResult) => void
  onDone: () => void
  onError: (error: Error) => void
}

interface AgentOptions
{
  think?: boolean | 'low' | 'medium' | 'high'
  // restrict the toolset — subagents get a read-only subset; defaults to allTools
  tools?: Tool[]
  // cap tool-call rounds (bounds subagent cost); undefined = unlimited
  maxIterations?: number
  // main agents register a subagent runner; subagents pass false so they don't
  // clobber the parent's runner
  registerSubagent?: boolean
  // pinned num_ctx inherited from a parent agent — subagents must use the same
  // value so they don't trigger an Ollama runner reload that wipes the KV cache
  numCtx?: number
}

// * Conversation agent w/ tool dispatch
export class Agent
{
  private client: OllamaClient
  private messages: OllamaMessage[] = []
  private model: string
  private baseUrl?: string
  private permissions: ToolPermissions
  private compactionConfig: CompactionConfig
  private thinkMode: boolean | 'low' | 'medium' | 'high'
  // per-instance toolset & its Ollama format — subagents run a restricted subset
  private tools: Tool[]
  private ollamaTools: OllamaTool[]
  // name -> tool for O(1) lookup; the toolset is fixed for the agent's lifetime
  private toolsByName: Map<string, Tool>
  private maxIterations?: number
  private estimatedTokenCount = 0
  // number of leading messages that stay byte-stable across compaction — the
  // system prompt plus accumulated frozen summary blocks. only the live tail
  // after this boundary is ever summarized, pruned, or trimmed
  private frozenPrefixLength = 1
  // pinned context window sent as options.num_ctx — held constant per session so
  // Ollama never reloads the runner & busts the KV cache (0 = not yet resolved)
  private numCtx = 0
  // in-flight context-window resolution — dedups concurrent callers (the TUI &
  // run()) onto a single /api/show; cleared on settle so failures can retry
  private contextWindowPromise?: Promise<number>
  private totalPromptTokens = 0
  private totalCompletionTokens = 0
  // cumulative nanoseconds of model time across the session
  private totalPromptEvalDurationNs = 0
  private totalEvalDurationNs = 0
  private contextWindowSize = 0
  private compactFailureCount = 0
  private compactionCount = 0
  private lastCompactedAt: string | null = null
  private reliabilityStats: ReliabilityStats = {
    repairedToolCalls: 0,
    nameRepairs: 0,
    stallNudges: 0,
    validationFailures: 0,
  }
  private onCompactionCallback?: (result: CompactionResult) => void
  private onCompactionStartCallback?: () => void

  constructor(
    model: string,
    baseUrl?: string,
    cwd?: string,
    options: AgentOptions = {}
  )
  {
    this.model = model
    this.baseUrl = baseUrl
    setOllamaHost(baseUrl)
    this.client = new OllamaClient(baseUrl)
    this.thinkMode = options.think ?? true
    this.tools = options.tools ?? allTools
    this.ollamaTools = this.tools.map(toolToOllamaFormat)
    this.toolsByName = new Map(this.tools.map((t) => [t.name, t]))
    this.maxIterations = options.maxIterations

    // set the global working directory — all tools resolve paths against this
    if (cwd) setCwd(cwd)

    // load per-tool permission policies from config
    this.permissions = resolvePermissions(getCwd())

    // compaction defaults — can be overridden via setCompactionConfig()
    this.compactionConfig = { ...DEFAULT_COMPACTION_CONFIG }

    // inherit a parent's pinned context window (subagents) so all requests to
    // the shared model use the same num_ctx & the KV cache survives
    if (options.numCtx && options.numCtx > 0)
    {
      this.numCtx = options.numCtx
      this.contextWindowSize = options.numCtx
      this.compactionConfig.contextWindow = options.numCtx
    }

    // inject system prompt as first message
    const systemContent = this.buildSystemContent(model)
    this.pushMessage({ role: 'system', content: systemContent })

    // expose this agent as the task-tool subagent runner (closes over this.model
    // so a later switchModel is reflected automatically)
    if (options.registerSubagent !== false)
    {
      setSubagentRunner((prompt, signal) => this.runSubagent(prompt, signal))
    }

    // track the active model so shutdown can unload it
    this.client.startKeepAlive(model)
  }

  // run a one-shot research subagent w/ a fresh context & read-only toolset,
  // returning its final text — shares the parent's loaded model, so never dispose
  private async runSubagent(
    prompt: string,
    signal?: AbortSignal
  ): Promise<SubagentResult>
  {
    const sub = new Agent(this.model, this.baseUrl, getCwd(), {
      think: this.thinkMode,
      tools: subagentTools,
      maxIterations: SUBAGENT_MAX_ITERATIONS,
      registerSubagent: false,
      numCtx: this.numCtx,
    })

    let text = ''
    let toolCount = 0
    let error: string | undefined

    await sub.run(
      prompt,
      {
        onToken: (token) =>
        {
          text += token
        },
        onToolCall: () =>
        {
          toolCount++
        },
        onToolResult: () =>
        {},
        // subagent tools are all read-only/always_allow, so this never fires;
        // deny anything unexpected that would otherwise need approval
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

    return { text: text.trim(), toolCount, error }
  }

  // stop client background work & unload the active model
  async dispose(): Promise<void>
  {
    await this.client.unloadModel(this.model)
  }

  // restore conversation from a previous session's messages
  // replaces the current history (keeps system prompt at index 0)
  restoreMessages(savedMessages: OllamaMessage[]): void
  {
    // find the system prompt from saved messages (or keep current one)
    const currentSystem = this.messages[0]
    const nonSystem = savedMessages.filter((m) => m.role !== 'system')
    this.messages = [currentSystem!, ...nonSystem]
    // recover the frozen-prefix boundary from the leading summary blocks
    this.frozenPrefixLength = countFrozenPrefix(this.messages)
    this.rebuildTokenEstimate()
  }

  // get a snapshot of the current message history (for session persistence)
  getMessages(): OllamaMessage[]
  {
    return [...this.messages]
  }

  // get the model name
  getModel(): string
  {
    return this.model
  }

  // switch to a different model in-place — keeps conversation history intact
  // unloads the old model, rebuilds the system prompt, & starts keep-alive for the new one
  async switchModel(nextModel: string): Promise<void>
  {
    const previousModel = this.model

    // unload the old model
    await this.client.unloadModel(previousModel)

    // swap to the new model & reset cached context window + pinned num_ctx
    // (a different model means a different runner, so the KV cache is cold anyway)
    this.model = nextModel
    this.contextWindowSize = 0
    this.numCtx = 0

    // rebuild the system prompt w/ the new model name
    const systemContent = this.buildSystemContent(nextModel)

    // replace messages[0] (the system prompt) in-place
    if (this.messages.length > 0 && this.messages[0]!.role === 'system')
    {
      const oldTokens = estimateMessageTokens(this.messages[0]!)
      this.messages[0] = { role: 'system', content: systemContent }
      const newTokens = estimateMessageTokens(this.messages[0]!)
      this.estimatedTokenCount += newTokens - oldTokens
    }
    else
    {
      // shouldn't happen, but handle gracefully
      this.messages.unshift({ role: 'system', content: systemContent })
      this.rebuildTokenEstimate()
    }

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
    const systemMsg = this.messages[0]!
    const cleared = this.messages.length - 1
    this.messages = [systemMsg]
    this.frozenPrefixLength = 1
    this.rebuildTokenEstimate()
    return cleared
  }

  // force conversation compaction & return before/after stats
  // returns null if compaction was skipped (too few messages or summary failed)
  async forceCompact(): Promise<CompactionResult | null>
  {
    const beforeTokens = this.estimatedTokenCount
    const beforeMessages = this.messages.length

    // need at least a system prompt + a few messages to compact
    if (this.messages.length < 4) return null

    // split at the compaction boundary — but use a relaxed config
    // so /compact always works even if auto-compaction wouldn't trigger
    const relaxedConfig: CompactionConfig = {
      ...this.compactionConfig,
      minMessagesForCompaction: 4,
      minRecentMessages: Math.min(
        this.compactionConfig.minRecentMessages,
        Math.max(Math.floor((this.messages.length - 1) / 2), 2)
      ),
    }

    // explicit /compact consolidates everything (including prior frozen
    // summaries) into a single block — splits from the system prompt only
    const { toSummarize, toKeep } = splitForCompaction(
      this.messages,
      relaxedConfig,
      1
    )
    if (toSummarize.length === 0) return null

    const summary = await this.buildCompactionSummary(toSummarize)
    if (summary === null) return null

    return this.applyCompactedSummary(
      summary,
      [this.messages[0]!],
      toKeep,
      beforeTokens,
      beforeMessages
    )
  }

  // get the estimated token count for the current conversation
  getEstimatedTokens(): number
  {
    return this.estimatedTokenCount
  }

  // get the message count (excluding system prompt)
  getMessageCount(): number
  {
    return Math.max(this.messages.length - 1, 0)
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

  // get the total number of successful compaction events this session
  getCompactionCount(): number
  {
    return this.compactionCount
  }

  // get the ISO timestamp of the last successful compaction (null if none)
  getLastCompactedAt(): string | null
  {
    return this.lastCompactedAt
  }

  // get reliability-layer counters for this session
  getReliabilityStats(): ReliabilityStats
  {
    return { ...this.reliabilityStats }
  }

  // fetch the model's context window from Ollama, cap it to a sane ceiling, &
  // pin it as num_ctx for the session. safe to call multiple times — only the
  // first resolution does work. capping keeps KV-cache memory bounded & makes
  // the compaction thresholds match what the server actually allocates
  async fetchContextWindow(): Promise<number>
  {
    if (this.contextWindowSize > 0) return this.contextWindowSize

    // share one in-flight request; clear the memo on settle so a transient
    // failure (numCtx still 0) retries on the next call instead of sticking
    this.contextWindowPromise ??= this.resolveContextWindow().finally(() =>
    {
      this.contextWindowPromise = undefined
    })

    return this.contextWindowPromise
  }

  // resolve the context window once: cap it, pin it as num_ctx, & align the
  // compaction thresholds to the window the server actually allocates
  private async resolveContextWindow(): Promise<number>
  {
    try
    {
      const info = await this.client.showModel(this.model)
      if (info.context_length > 0)
      {
        const cap = resolveContextConfig(getCwd()).maxNumCtx
        const pinned = Math.min(info.context_length, cap)

        this.contextWindowSize = pinned
        this.numCtx = pinned
        this.compactionConfig = {
          ...this.compactionConfig,
          contextWindow: pinned,
        }
      }
    }
    catch
    {
      // non-fatal — keep using default (0 = unknown)
    }

    return this.contextWindowSize
  }

  // append a message while maintaining the cached token estimate
  private pushMessage(message: OllamaMessage): void
  {
    this.messages.push(message)
    this.estimatedTokenCount += estimateMessageTokens(message)
  }

  // append several messages while maintaining the cached token estimate
  private pushMessages(messages: OllamaMessage[]): void
  {
    for (const message of messages)
    {
      this.pushMessage(message)
    }
  }

  // rebuild the cached token estimate after bulk message replacement
  private rebuildTokenEstimate(): void
  {
    this.estimatedTokenCount = estimateTotalTokens(this.messages)
  }

  // clear compaction callbacks when the run() loop exits
  private clearCompactionCallbacks(): void
  {
    this.onCompactionCallback = undefined
    this.onCompactionStartCallback = undefined
  }

  // build the system prompt for a model — same wiring at construct & switch
  private buildSystemContent(model: string): string
  {
    return buildSystemPrompt({ model, cwd: getCwd(), tools: this.tools })
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
  }

  // build a model-generated summary for older messages
  // returns null when the model call fails or yields an empty summary
  private async buildCompactionSummary(
    messagesToSummarize: OllamaMessage[]
  ): Promise<string | null>
  {
    const cleaned = stripThinkingForCompaction(messagesToSummarize)
    const compactionPrompt = buildCompactionPrompt(cleaned)
    let summary = ''

    this.onCompactionStartCallback?.()

    try
    {
      for await (const chunk of this.client.chatStream({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: COMPACTION_SYSTEM_PROMPT,
          },
          { role: 'user', content: compactionPrompt },
        ],
        num_ctx: this.numCtx || undefined,
      }))
      {
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

  // append the summary as a new frozen block after the stable prefix & report
  // stats. the frozen prefix (system + prior summaries) stays byte-identical so
  // the model's KV cache is reused through it on the next turn
  private applyCompactedSummary(
    summary: string,
    frozenPrefix: OllamaMessage[],
    toKeep: OllamaMessage[],
    beforeTokens: number,
    beforeMessages: number
  ): CompactionResult
  {
    this.messages = buildCompactedMessages(frozenPrefix, summary, toKeep)
    this.frozenPrefixLength = frozenPrefix.length + 1
    this.rebuildTokenEstimate()

    this.compactionCount++
    this.lastCompactedAt = new Date().toISOString()

    const result: CompactionResult = {
      type: 'summarized',
      beforeTokens,
      afterTokens: this.estimatedTokenCount,
      beforeMessages,
      afterMessages: this.messages.length,
    }

    this.onCompactionCallback?.(result)
    return result
  }

  // trim to recent history while keeping the frozen prefix (system + summaries)
  // intact — only the live tail is dropped, so the cached prefix survives
  private trimHistoryToMax(): void
  {
    const frozen = this.messages.slice(0, this.frozenPrefixLength)
    const liveBudget = Math.max(MAX_HISTORY - this.frozenPrefixLength, 0)
    // guard: slice(-0) returns the whole array, so an empty budget must short
    // out explicitly rather than keeping the entire live tail
    const recent =
      liveBudget === 0
        ? []
        : this.messages.slice(this.frozenPrefixLength).slice(-liveBudget)
    this.messages = [...frozen, ...recent]
    this.rebuildTokenEstimate()
  }

  // count failed summarization attempts & fall back to trimming
  // reports the trim honestly as 'trimmed' (not a fake summarization)
  private recordCompactionFailure(
    beforeTokens: number,
    beforeMessages: number
  ): void
  {
    this.compactFailureCount++
    if (this.compactFailureCount < MAX_COMPACT_FAILURES) return

    this.trimHistoryToMax()
    this.compactFailureCount = 0

    // only report when the trim actually dropped messages
    if (this.messages.length === beforeMessages) return

    this.onCompactionCallback?.({
      type: 'trimmed',
      beforeTokens,
      afterTokens: this.estimatedTokenCount,
      beforeMessages,
      afterMessages: this.messages.length,
    })
  }

  // look up a tool in this agent's own toolset — scoping lookup here (not the
  // global registry) keeps subagents from reaching tools outside their subset
  private getOwnTool(name: string): Tool | undefined
  {
    return this.toolsByName.get(name)
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
      const match = this.tools.find(
        (t) => normalizeToolName(t.name) === normalized
      )

      if (match)
      {
        call.function.name = match.name
        this.reliabilityStats.nameRepairs++
      }
    }
  }

  // identify read-only, approval-free tools that can run out of order internally
  // derives parallel-safety from the tool's readOnly flag (not a separate list)
  // while keeping the live policy check so approval-gated tools still serialize
  private canRunToolInParallel(toolName: string): boolean
  {
    return (
      this.getOwnTool(toolName)?.readOnly === true &&
      getToolPolicy(this.permissions, toolName) === 'always_allow'
    )
  }

  // execute a registered tool & convert thrown errors to tool results
  private async executeTool(
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<ToolResult>
  {
    const tool = this.getOwnTool(toolName)

    if (!tool)
    {
      return {
        output: '',
        error: `Unknown tool: ${toolName}`,
      }
    }

    // schema-check & coerce args before executing — a friendly error here lets
    // the model retry w/ fixed args instead of hitting a runtime failure
    const validation = validateToolArgs(tool, toolArgs)
    if (!validation.ok)
    {
      this.reliabilityStats.validationFailures++
      return { output: '', error: validation.error }
    }

    try
    {
      return await tool.execute(validation.args)
    }
    catch (err)
    {
      return {
        output: '',
        error: `Tool execution failed for ${toolName}: ${toError(err).message}`,
      }
    }
  }

  // format a tool message for the next model turn — execution errors, policy
  // denials, approval rejections, & interruptions all use the 'Error: ' prefix
  // so the model sees one consistent failure shape
  private buildToolMessage(
    toolName: string,
    output: string,
    error?: string
  ): OllamaMessage
  {
    // bound output so a single huge result can't overflow the window or stall
    // the server during prefill (errors stay short, so cap output only)
    const capped = capToolOutput(output)
    const content = error
      ? capped
        ? `Error: ${error}\n${capped}`
        : `Error: ${error}`
      : capped

    return {
      role: 'tool',
      tool_name: toolName,
      content,
    }
  }

  // two-phase compaction: prune tool results first, then summarize if needed
  private async compactIfNeeded(): Promise<void>
  {
    // phase 1: prune old tool results (no model call, instant)
    if (
      shouldPrune(
        this.messages.length,
        this.estimatedTokenCount,
        this.compactionConfig
      )
    )
    {
      const beforeTokens = this.estimatedTokenCount
      const beforeMessages = this.messages.length
      // protect the frozen prefix — only prune tool results in the live tail
      const { prunedMessages, prunedCount } = pruneToolResults(
        this.messages,
        undefined,
        this.frozenPrefixLength
      )

      if (prunedCount > 0)
      {
        this.messages = prunedMessages
        this.rebuildTokenEstimate()
        this.compactionCount++
        this.lastCompactedAt = new Date().toISOString()

        this.onCompactionCallback?.({
          type: 'pruned',
          beforeTokens,
          afterTokens: this.estimatedTokenCount,
          beforeMessages,
          afterMessages: this.messages.length,
          prunedResults: prunedCount,
        })
      }
    }

    // phase 2: full summarization if still over threshold
    if (
      !shouldCompactByTotal(
        this.messages.length,
        this.estimatedTokenCount,
        this.compactionConfig
      )
    )
    {
      return
    }

    // append a new frozen summary block by default; once they accumulate past
    // the cap, consolidate everything (from the system prompt) into one block
    const consolidate = this.frozenPrefixLength - 1 >= MAX_FROZEN_SUMMARIES
    const splitFrom = consolidate ? 1 : this.frozenPrefixLength

    const { toSummarize, toKeep } = splitForCompaction(
      this.messages,
      this.compactionConfig,
      splitFrom
    )
    if (toSummarize.length === 0) return

    const frozenPrefix = this.messages.slice(0, splitFrom)
    const beforeTokens = this.estimatedTokenCount
    const beforeMessages = this.messages.length

    const summary = await this.buildCompactionSummary(toSummarize)

    if (summary === null)
    {
      this.recordCompactionFailure(beforeTokens, beforeMessages)
      return
    }

    this.compactFailureCount = 0
    this.applyCompactedSummary(
      summary,
      frozenPrefix,
      toKeep,
      beforeTokens,
      beforeMessages
    )
  }

  // run a user message through the agent loop
  // pass an AbortSignal to cancel mid-stream or mid-tool
  async run(
    userMessage: string,
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void>
  {
    // resolve the num_ctx pin before the first request so every turn (incl. the
    // first) hits the runner w/ the same num_ctx — otherwise turn 1 loads at
    // the Modelfile default & turn 2 reloads, wiping the KV cache. no-op once
    // resolved & instant for subagents (they inherit a pinned window)
    await this.fetchContextWindow()

    this.pushMessage({ role: 'user', content: userMessage })

    // store compaction callbacks so compactIfNeeded() can invoke them
    this.onCompactionCallback = events.onCompaction
    this.onCompactionStartCallback = events.onCompactionStart

    // keep going while the model wants to call tools
    let iterations = 0
    let stallNudges = 0
    while (true)
    {
      // check for abort before each iteration
      if (signal?.aborted)
      {
        this.finishRun(events)
        return
      }

      // safety cap on tool-call rounds — bounds subagent cost (unset = unlimited)
      iterations++
      if (this.maxIterations !== undefined && iterations > this.maxIterations)
      {
        this.finishRun(events)
        return
      }

      // compact conversation if approaching context limits
      await this.compactIfNeeded()

      // trim history if it grows too large, preserving system prompt
      if (this.messages.length > MAX_HISTORY)
      {
        this.trimHistoryToMax()
      }

      let fullContent = ''
      let fullThinking = ''
      let toolCalls: OllamaToolCall[] = []

      try
      {
        for await (const chunk of this.client.chatStream(
          {
            model: this.model,
            messages: this.messages,
            tools: this.ollamaTools,
            think: this.thinkMode,
            num_ctx: this.numCtx || undefined,
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
              contextTokens: this.estimatedTokenCount,
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
          this.finishRun(events)
          return
        }

        this.clearCompactionCallbacks()
        events.onError(toError(err))
        return
      }

      // aborted mid-stream — save partial content & stop
      if (signal?.aborted)
      {
        this.recordPartialOnAbort(fullContent, fullThinking)
        this.finishRun(events)
        return
      }

      // repair pass: recover tool calls the model emitted as text content —
      // the most common local-model failure mode (call-shaped JSON, no call)
      if (toolCalls.length === 0 && fullContent.trim())
      {
        const repaired = parseToolCallsFromContent(
          fullContent,
          this.tools.map((t) => t.name)
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
        assistantMessage.tool_calls = toolCalls
      }
      this.pushMessage(assistantMessage)

      // no tool calls means the model is done
      if (toolCalls.length === 0)
      {
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

        this.finishRun(events)
        return
      }

      // run read-only tools in parallel batches & keep approval flow serial
      // each call's index is its callId — correlates the result to its UI block
      const toolResults: OllamaMessage[] = []
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

        if (this.canRunToolInParallel(nextToolName))
        {
          // collect a run of consecutive parallel-safe calls, each w/ a stable id
          const batch: ToolInvocation[] = []

          while (toolIndex < toolCalls.length)
          {
            const candidate = toolCalls[toolIndex]!
            if (!this.canRunToolInParallel(candidate.function.name)) break

            batch.push({
              id: toolIndex,
              name: candidate.function.name,
              args: candidate.function.arguments ?? {},
            })
            toolIndex++
          }

          for (const item of batch)
          {
            events.onToolCall(item.name, item.args, item.id)
          }

          // read-only tools are side-effect-free & quick — let the batch finish
          // so every announced call records a result (no dangling tool_calls on
          // abort); the post-loop check stops the run afterward
          let results: ToolResult[]
          try
          {
            results = await Promise.all(
              batch.map((item) => this.executeTool(item.name, item.args))
            )
          }
          catch (err)
          {
            const errorMsg = `Parallel tool execution failed: ${toError(err).message}`
            for (const item of batch)
            {
              events.onToolResult(item.name, '', errorMsg, item.id)
              toolResults.push(this.buildToolMessage(item.name, '', errorMsg))
            }
            continue
          }

          for (const [index, result] of results.entries())
          {
            const item = batch[index]!
            events.onToolResult(
              item.name,
              result.output,
              result.error,
              item.id,
              result.diff
            )
            toolResults.push(
              this.buildToolMessage(item.name, result.output, result.error)
            )
          }

          continue
        }

        const callId = toolIndex
        const call = toolCalls[toolIndex]!
        toolIndex++
        const toolName = call.function.name
        const toolArgs = call.function.arguments ?? {}
        events.onToolCall(toolName, toolArgs, callId)

        const tool = this.getOwnTool(toolName)
        if (!tool)
        {
          const errorMsg = `Unknown tool: ${toolName}`
          events.onToolResult(toolName, '', errorMsg, callId)
          toolResults.push(this.buildToolMessage(toolName, '', errorMsg))
          continue
        }

        // check per-tool permission policy
        const policy = getToolPolicy(this.permissions, toolName)

        if (policy === 'always_deny')
        {
          const deniedMsg = `Tool ${toolName} is denied by permission policy`
          events.onToolResult(toolName, '', deniedMsg, callId)
          toolResults.push(this.buildToolMessage(toolName, '', deniedMsg))
          continue
        }

        if (policy === 'require_approval')
        {
          // race approval against abort signal
          let approved: boolean
          try
          {
            approved = await raceAbort(
              events.onToolApproval(toolName, toolArgs),
              signal
            )
          }
          catch (err)
          {
            // record a result for the announced call so history stays consistent
            const errorMsg = signal?.aborted
              ? 'Tool call interrupted'
              : `Tool approval failed for ${toolName}: ${toError(err).message}`
            events.onToolResult(toolName, '', errorMsg, callId)
            toolResults.push(this.buildToolMessage(toolName, '', errorMsg))

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
            events.onToolResult(toolName, '', rejectedMsg, callId)
            toolResults.push(this.buildToolMessage(toolName, '', rejectedMsg))
            continue
          }
        }

        const result = await this.executeTool(toolName, toolArgs)
        events.onToolResult(
          toolName,
          result.output,
          result.error,
          callId,
          result.diff
        )
        toolResults.push(
          this.buildToolMessage(toolName, result.output, result.error)
        )
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
              'Tool call interrupted'
            )
          )
          toolIndex++
        }
      }

      if (toolResults.length > 0)
      {
        this.pushMessages(toolResults)
      }

      if (abortedDuringTools)
      {
        this.finishRun(events)
        return
      }
    }
  }
}
