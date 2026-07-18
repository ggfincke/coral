// src/agent/loop/compactor.ts
// coordinate revision-checked conversation compaction

import type { AgentInferenceClient } from '../inference-client.js'
import type {
  ModelRequestMessage,
  OllamaMessage,
} from '../../types/inference.js'
import {
  buildCompactionPrompt,
  DEFAULT_COMPACTION_CONFIG,
  shouldCompactByTotal,
  shouldPrune,
  stripThinkingForCompaction,
  type CompactionConfig,
  type CompactionResult,
} from '../state/compaction.js'
import {
  DEFAULT_MAX_HISTORY,
  type ConversationMessageAnchor,
  type ConversationState,
  type ConversationTransition,
} from '../state/conversation.js'
import { requestBudgetCapacity } from '../request/budget.js'
import {
  estimateModelRequestMessageTokens,
  estimateRequestFramingTokens,
} from '../request/projection.js'

const COMPACTION_SYSTEM_PROMPT =
  'You are a helpful assistant. Produce a concise structured summary of the conversation.'

export interface CompactionRuntime
{
  model: string
  contextWindow: number
  numCtx?: number
  toolDefinitionTokens: number
}

export interface CompactionCallbacks
{
  onStart?: () => void
  onResult?: (result: CompactionResult) => void
}

export interface AutomaticCompactionOptions
{
  runtime: CompactionRuntime
  volatileTokens?: number
  signal?: AbortSignal
  callbacks?: CompactionCallbacks
}

export interface HardFitCompactionOptions
{
  runtime: CompactionRuntime
  anchor: ConversationMessageAnchor
  signal?: AbortSignal
  callbacks?: CompactionCallbacks
}

// * Coordinate compaction inference, state plans, and event snapshots
export class CompactionCoordinator
{
  private config: CompactionConfig

  constructor(
    private readonly state: ConversationState,
    private readonly client: AgentInferenceClient,
    initialConfig: CompactionConfig = DEFAULT_COMPACTION_CONFIG
  )
  {
    this.config = { ...initialConfig }
  }

  setConfig(config: Partial<CompactionConfig>): void
  {
    this.config = { ...this.config, ...config }
  }

  setPromptLimit(promptLimit: number): void
  {
    this.config = { ...this.config, contextWindow: promptLimit }
  }

  estimateContextTokens(
    toolDefinitionTokens: number,
    volatileTokens = 0
  ): number
  {
    return this.contextTokensForStored(
      this.state.getEstimatedTokens(),
      this.state.getMessageCount(),
      toolDefinitionTokens,
      volatileTokens
    )
  }

  async forceCompact(
    runtime: CompactionRuntime,
    signal?: AbortSignal
  ): Promise<CompactionResult | null>
  {
    const prepared = this.state.prepareSummary({
      mode: 'manual',
      config: this.config,
    })
    if (!prepared) return null

    const summary = await this.buildSummary(
      prepared.messages,
      runtime,
      undefined,
      signal
    )
    if (summary === null) return null
    const committed = this.state.commitSummary(
      prepared.plan,
      summary,
      new Date().toISOString()
    )
    if (committed.status === 'stale') return null
    return this.resultForTransition(committed.transition, runtime)
  }

  async compactIfNeeded(options: AutomaticCompactionOptions): Promise<void>
  {
    const { runtime, volatileTokens = 0, signal, callbacks } = options
    if (signal?.aborted) return
    const totalTokens = this.estimateContextTokens(
      runtime.toolDefinitionTokens,
      volatileTokens
    )

    // prune old tool results before spending one model request on a summary
    if (shouldPrune(this.state.getMessageCount(), totalTokens, this.config))
    {
      const transition = this.state.pruneToolResults(new Date().toISOString())
      if (transition)
      {
        if (signal?.aborted) return
        this.resultForTransition(transition, runtime, callbacks)
      }
    }

    const totalAfterPrune = this.estimateContextTokens(
      runtime.toolDefinitionTokens,
      volatileTokens
    )
    if (
      !shouldCompactByTotal(
        this.state.getMessageCount(),
        totalAfterPrune,
        this.config
      )
    )
    {
      return
    }

    const prepared = this.state.prepareSummary({
      mode: 'automatic',
      config: this.config,
    })
    if (!prepared) return

    const summary = await this.buildSummary(
      prepared.messages,
      runtime,
      callbacks,
      signal
    )
    if (summary === null)
    {
      // cancellation is not an automatic-compaction failure
      if (signal?.aborted) return
      const failure = this.state.recordAutomaticSummaryFailure(
        prepared.plan,
        DEFAULT_MAX_HISTORY
      )
      if (failure.status === 'recorded' && failure.transition)
      {
        this.resultForTransition(failure.transition, runtime, callbacks)
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
      this.resultForTransition(committed.transition, runtime, callbacks)
    }
  }

  async compactHistoryForHardFit(
    options: HardFitCompactionOptions
  ): Promise<boolean>
  {
    const { runtime, anchor, signal, callbacks } = options
    signal?.throwIfAborted()
    if (this.state.indexOf(anchor) <= 1) return false
    const prepared = this.state.prepareSummary({ mode: 'hard-fit' })
    if (!prepared) return false
    const summary = await this.buildSummary(
      prepared.messages,
      runtime,
      callbacks,
      signal
    )
    signal?.throwIfAborted()
    if (summary === null) return false
    const committed = this.state.commitSummary(
      prepared.plan,
      summary,
      new Date().toISOString()
    )
    if (committed.status === 'stale') return false
    this.resultForTransition(committed.transition, runtime, callbacks)
    return true
  }

  private contextTokensForStored(
    storedTokens: number,
    messageCount: number,
    toolDefinitionTokens: number,
    volatileTokens = 0
  ): number
  {
    return (
      storedTokens +
      toolDefinitionTokens +
      estimateRequestFramingTokens(messageCount) +
      volatileTokens
    )
  }

  private resultForTransition(
    transition: ConversationTransition,
    runtime: CompactionRuntime,
    callbacks?: CompactionCallbacks
  ): CompactionResult
  {
    const result: CompactionResult = {
      type: transition.type,
      beforeTokens: this.contextTokensForStored(
        transition.beforeStoredTokens,
        transition.beforeMessages,
        runtime.toolDefinitionTokens
      ),
      afterTokens: this.contextTokensForStored(
        transition.afterStoredTokens,
        transition.afterMessages,
        runtime.toolDefinitionTokens
      ),
      beforeMessages: transition.beforeMessages,
      afterMessages: transition.afterMessages,
      ...(transition.prunedResults === undefined
        ? {}
        : { prunedResults: transition.prunedResults }),
    }
    callbacks?.onResult?.(result)
    return result
  }

  // preserve instructions and the newest transcript tail within the prompt
  private fitPrompt(content: string, maxTokens: number): string | null
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

  // build a model-generated summary, returning null on failure or empty text
  private async buildSummary(
    messagesToSummarize: OllamaMessage[],
    runtime: CompactionRuntime,
    callbacks?: CompactionCallbacks,
    signal?: AbortSignal
  ): Promise<string | null>
  {
    const cleaned = stripThinkingForCompaction(messagesToSummarize)
    const fullPrompt = buildCompactionPrompt(cleaned)
    const capacity = requestBudgetCapacity(runtime.contextWindow)
    const systemMessage: ModelRequestMessage = {
      role: 'system',
      content: COMPACTION_SYSTEM_PROMPT,
    }
    const promptTokens =
      capacity.summaryPromptLimit -
      estimateModelRequestMessageTokens(systemMessage) -
      estimateRequestFramingTokens(2)
    const compactionPrompt = this.fitPrompt(fullPrompt, promptTokens)
    if (compactionPrompt === null) return null
    let summary = ''

    callbacks?.onStart?.()

    try
    {
      for await (const chunk of this.client.chatStream(
        {
          model: runtime.model,
          messages: [
            systemMessage,
            { role: 'user', content: compactionPrompt },
          ],
          num_ctx: runtime.numCtx,
          num_predict: capacity.summaryResponseReserve,
        },
        signal
      ))
      {
        if (signal?.aborted) return null
        if (chunk.message.content) summary += chunk.message.content
      }
    }
    catch
    {
      return null
    }

    if (!summary.trim()) return null
    return summary
  }
}
