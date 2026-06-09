// src/agent/agent.ts
// conversation loop w/ tool-use cycling

import { OllamaClient } from '../ollama/client.js'
import type {
  OllamaMessage,
  OllamaToolCall,
} from '../ollama/client.js'
import { allTools, getToolByName, toolToOllamaFormat } from '../tools/index.js'
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
  MAX_COMPACT_FAILURES,
  type CompactionConfig,
  type CompactionResult,
  DEFAULT_COMPACTION_CONFIG,
} from './compaction.js'

export type { CompactionResult } from './compaction.js'
import { toError } from '../utils/errors.js'

// pre-compute Ollama tool format (static after registration)
const ollamaTools = allTools.map(toolToOllamaFormat)

// max messages to keep in history (system prompt + recent context)
const MAX_HISTORY = 100

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
function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T>
{
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))

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

// token usage from Ollama's response metrics
// durations are nanoseconds — Ollama's native unit from prompt_eval_duration / eval_duration
export interface TokenUsage
{
  promptTokens: number
  completionTokens: number
  totalPromptTokens: number
  totalCompletionTokens: number
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
  onToolCall: (name: string, args: Record<string, unknown>) => void
  onToolResult: (name: string, result: string, error?: string) => void
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
}

// * Conversation agent w/ tool dispatch
export class Agent
{
  private client: OllamaClient
  private messages: OllamaMessage[] = []
  private model: string
  private permissions: ToolPermissions
  private compactionConfig: CompactionConfig
  private thinkMode: boolean | 'low' | 'medium' | 'high'
  private estimatedTokenCount = 0
  private totalPromptTokens = 0
  private totalCompletionTokens = 0
  // cumulative nanoseconds of model time across the session
  private totalPromptEvalDurationNs = 0
  private totalEvalDurationNs = 0
  private contextWindowSize = 0
  private compactFailureCount = 0
  private compactionCount = 0
  private lastCompactedAt: string | null = null
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
    this.client = new OllamaClient(baseUrl)
    this.thinkMode = options.think ?? true

    // set the global working directory — all tools resolve paths against this
    if (cwd) setCwd(cwd)

    // load per-tool permission policies from config
    this.permissions = resolvePermissions(getCwd())

    // compaction defaults — can be overridden via setCompactionConfig()
    this.compactionConfig = { ...DEFAULT_COMPACTION_CONFIG }

    // inject system prompt as first message
    const systemContent = buildSystemPrompt({
      model,
      cwd: getCwd(),
      tools: allTools,
    })
    this.pushMessage({ role: 'system', content: systemContent })

    // track the active model so shutdown can unload it
    this.client.startKeepAlive(model)
  }

  // stop client background work & unload the active model
  async dispose(): Promise<void>
  {
    this.client.stopKeepAlive()
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

    // unload the old model & stop its keep-alive
    this.client.stopKeepAlive()
    await this.client.unloadModel(previousModel)

    // swap to the new model & reset cached context window
    this.model = nextModel
    this.contextWindowSize = 0

    // rebuild the system prompt w/ the new model name
    const systemContent = buildSystemPrompt({
      model: nextModel,
      cwd: getCwd(),
      tools: allTools,
    })

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

    const { toSummarize, toKeep } = splitForCompaction(
      this.messages,
      relaxedConfig
    )
    if (toSummarize.length === 0) return null

    // strip thinking blocks before feeding to the summarizer
    const cleaned = stripThinkingForCompaction(toSummarize)
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
            content:
              'You are a helpful assistant. Produce a concise structured summary of the conversation.',
          },
          { role: 'user', content: compactionPrompt },
        ],
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

    const systemMsg = this.messages[0]!
    this.messages = buildCompactedMessages(systemMsg, summary, toKeep)
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

  // get the cached context window size (0 = unknown)
  getContextWindowSize(): number
  {
    return this.contextWindowSize
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

  // fetch the context window size from Ollama & cache it
  // safe to call multiple times — only fetches once per model
  async fetchContextWindow(): Promise<number>
  {
    if (this.contextWindowSize > 0) return this.contextWindowSize

    try
    {
      const info = await this.client.showModel(this.model)
      if (info.context_length > 0)
      {
        this.contextWindowSize = info.context_length
        // update compaction config w/ actual context window
        this.compactionConfig = {
          ...this.compactionConfig,
          contextWindow: info.context_length,
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

  // two-phase compaction: prune tool results first, then summarize if needed
  private async compactIfNeeded(): Promise<void>
  {
    // phase 1: prune old tool results (no model call, instant)
    if (shouldPrune(
      this.messages.length,
      this.estimatedTokenCount,
      this.compactionConfig
    ))
    {
      const beforeTokens = this.estimatedTokenCount
      const beforeMessages = this.messages.length
      const { prunedMessages, prunedCount } = pruneToolResults(this.messages)

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
    if (!shouldCompactByTotal(
      this.messages.length,
      this.estimatedTokenCount,
      this.compactionConfig
    ))
    {
      return
    }

    const { toSummarize, toKeep } = splitForCompaction(
      this.messages,
      this.compactionConfig
    )
    if (toSummarize.length === 0) return

    const beforeTokens = this.estimatedTokenCount
    const beforeMessages = this.messages.length

    // strip thinking blocks before feeding to the summarizer
    const cleaned = stripThinkingForCompaction(toSummarize)
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
            content:
              'You are a helpful assistant. Produce a concise structured summary of the conversation.',
          },
          { role: 'user', content: compactionPrompt },
        ],
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
      this.compactFailureCount++
      if (this.compactFailureCount >= MAX_COMPACT_FAILURES)
      {
        // circuit breaker: fall back to brute trim
        const systemMsg = this.messages[0]
        const recent = this.messages.slice(-(MAX_HISTORY - 1))
        this.messages = [systemMsg!, ...recent]
        this.rebuildTokenEstimate()
        this.compactFailureCount = 0

        this.onCompactionCallback?.({
          type: 'summarized',
          beforeTokens,
          afterTokens: this.estimatedTokenCount,
          beforeMessages,
          afterMessages: this.messages.length,
        })
      }
      return
    }

    if (!summary.trim())
    {
      this.compactFailureCount++
      if (this.compactFailureCount >= MAX_COMPACT_FAILURES)
      {
        const systemMsg = this.messages[0]
        const recent = this.messages.slice(-(MAX_HISTORY - 1))
        this.messages = [systemMsg!, ...recent]
        this.rebuildTokenEstimate()
        this.compactFailureCount = 0
      }
      return
    }

    // success — rebuild messages w/ summary replacing old turns
    this.compactFailureCount = 0
    const systemMsg = this.messages[0]!
    this.messages = buildCompactedMessages(systemMsg, summary, toKeep)
    this.rebuildTokenEstimate()

    this.compactionCount++
    this.lastCompactedAt = new Date().toISOString()

    this.onCompactionCallback?.({
      type: 'summarized',
      beforeTokens,
      afterTokens: this.estimatedTokenCount,
      beforeMessages,
      afterMessages: this.messages.length,
    })
  }

  // run a user message through the agent loop
  // pass an AbortSignal to cancel mid-stream or mid-tool
  async run(
    userMessage: string,
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void>
  {
    this.pushMessage({ role: 'user', content: userMessage })

    // store compaction callbacks so compactIfNeeded() can invoke them
    this.onCompactionCallback = events.onCompaction
    this.onCompactionStartCallback = events.onCompactionStart

    // keep going while the model wants to call tools
    while (true)
    {
      // check for abort before each iteration
      if (signal?.aborted)
      {
        this.clearCompactionCallbacks()
        events.onDone()
        return
      }

      // compact conversation if approaching context limits
      await this.compactIfNeeded()

      // trim history if it grows too large, preserving system prompt
      if (this.messages.length > MAX_HISTORY)
      {
        const systemMsg = this.messages[0]
        const recent = this.messages.slice(-(MAX_HISTORY - 1))
        this.messages = [systemMsg, ...recent]
        this.rebuildTokenEstimate()
      }

      let fullContent = ''
      let fullThinking = ''
      let toolCalls: OllamaToolCall[] = []

      try
      {
        for await (const chunk of this.client.chatStream({
          model: this.model,
          messages: this.messages,
          tools: ollamaTools,
          think: this.thinkMode,
        }, signal))
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
          if (fullContent || fullThinking)
          {
            const partial: OllamaMessage = {
              role: 'assistant',
              content: fullContent || '(interrupted)',
            }
            if (fullThinking) partial.thinking = fullThinking
            this.pushMessage(partial)
          }

          this.clearCompactionCallbacks()
          events.onDone()
          return
        }

        this.clearCompactionCallbacks()
        events.onError(toError(err))
        return
      }

      // aborted mid-stream — save partial content & stop
      if (signal?.aborted)
      {
        if (fullContent || fullThinking)
        {
          const partial: OllamaMessage = {
            role: 'assistant',
            content: fullContent || '(interrupted)',
          }
          if (fullThinking) partial.thinking = fullThinking
          this.pushMessage(partial)
        }

        this.clearCompactionCallbacks()
        events.onDone()
        return
      }

      // record assistant message
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
        this.clearCompactionCallbacks()
        events.onDone()
        return
      }

      // execute tool calls sequentially (approval requires serial flow)
      const toolResults: OllamaMessage[] = []
      let abortedDuringTools = false

      for (const call of toolCalls)
      {
        if (signal?.aborted)
        {
          abortedDuringTools = true
          break
        }

        const toolName = call.function.name
        const toolArgs = call.function.arguments ?? {}
        events.onToolCall(toolName, toolArgs)

        const tool = getToolByName(toolName)
        if (!tool)
        {
          const errorMsg = `Unknown tool: ${toolName}`
          events.onToolResult(toolName, '', errorMsg)
          toolResults.push({
            role: 'tool',
            tool_name: toolName,
            content: errorMsg,
          })
          continue
        }

        // check per-tool permission policy
        const policy = getToolPolicy(this.permissions, toolName)

        if (policy === 'always_deny')
        {
          const deniedMsg = `Tool ${toolName} is denied by permission policy`
          events.onToolResult(toolName, '', deniedMsg)
          toolResults.push({
            role: 'tool',
            tool_name: toolName,
            content: deniedMsg,
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
              events.onToolApproval(toolName, toolArgs),
              signal
            )
          }
          catch (err)
          {
            if (signal?.aborted)
            {
              abortedDuringTools = true
              break
            }

            const errorMsg = `Tool approval failed for ${toolName}: ${toError(err).message}`
            events.onToolResult(toolName, '', errorMsg)
            toolResults.push({
              role: 'tool',
              tool_name: toolName,
              content: errorMsg,
            })
            continue
          }

          if (!approved)
          {
            const rejectedMsg = `Tool call rejected by user`
            events.onToolResult(toolName, '', rejectedMsg)
            toolResults.push({
              role: 'tool',
              tool_name: toolName,
              content: rejectedMsg,
            })
            continue
          }
        }

        let result
        try
        {
          result = await tool.execute(toolArgs)
        }
        catch (err)
        {
          result = {
            output: '',
            error: `Tool execution failed for ${toolName}: ${toError(err).message}`,
          }
        }

        events.onToolResult(toolName, result.output, result.error)
        toolResults.push({
          role: 'tool',
          tool_name: toolName,
          content: result.error
            ? `Error: ${result.error}\n${result.output}`
            : result.output,
        })
      }

      if (toolResults.length > 0)
      {
        this.pushMessages(toolResults)
      }

      if (abortedDuringTools)
      {
        this.clearCompactionCallbacks()
        events.onDone()
        return
      }
    }
  }
}
