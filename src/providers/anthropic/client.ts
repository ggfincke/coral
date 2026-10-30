// src/providers/anthropic/client.ts
// stream Claude models through the Anthropic Messages API

import Anthropic from '@anthropic-ai/sdk'
import type { AgentInferenceClient } from '../../agent/inference-client.js'
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelInfo,
} from '../../types/inference.js'
import type { HostedProviderSettings } from '../config.js'
import { finalChunkFrom, toAnthropicRequest } from './wire.js'

// used only when the Models API omits a limit
const FALLBACK_INPUT_TOKENS = 200_000
const FALLBACK_OUTPUT_TOKENS = 64_000

// translate SDK failures into short actionable text without request bodies
function describeError(err: unknown, model?: string): Error
{
  if (err instanceof Anthropic.AuthenticationError)
  {
    return new Error('Anthropic rejected ANTHROPIC_API_KEY (401)')
  }
  if (err instanceof Anthropic.PermissionDeniedError)
  {
    return new Error(
      'Anthropic denied access (403); check the key has API credits'
    )
  }
  if (err instanceof Anthropic.NotFoundError)
  {
    return new Error(
      `Anthropic has no model ${model ? `"${model}"` : 'by that name'} (404)`
    )
  }
  if (err instanceof Anthropic.RateLimitError)
  {
    return new Error('Anthropic rate limit hit (429); retry shortly')
  }
  if (err instanceof Anthropic.APIConnectionError)
  {
    return new Error(`Cannot reach the Anthropic API: ${err.message}`)
  }
  if (err instanceof Anthropic.APIError)
  {
    if (err.status === 529)
    {
      return new Error('Anthropic is overloaded (529); retry shortly')
    }
    return new Error(`Anthropic API error ${err.status ?? ''}: ${err.message}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Hosted inference client for Claude models. Receives unprefixed model ids
 * from the router and emits Coral's stream contract: text and thinking deltas,
 * then one terminal chunk with whole tool calls, usage, and replay state.
 */
export class AnthropicClient implements AgentInferenceClient
{
  private readonly sdk: Anthropic
  private readonly settings: HostedProviderSettings

  constructor(settings: HostedProviderSettings)
  {
    this.settings = settings
    this.sdk = new Anthropic({ apiKey: settings.apiKey })
  }

  // hosted models have no runner residency to manage
  startKeepAlive(): void
  {}

  // the window is pinned once per session, so a failed lookup still reports a
  // hosted profile; the chat request then surfaces the real error
  async showModel(model: string, signal?: AbortSignal): Promise<ModelInfo>
  {
    let nativeInput = FALLBACK_INPUT_TOKENS
    let maxOutputTokens = FALLBACK_OUTPUT_TOKENS
    try
    {
      const info = await this.sdk.models.retrieve(model, {}, { signal })
      nativeInput = info.max_input_tokens ?? nativeInput
      maxOutputTokens = info.max_tokens ?? maxOutputTokens
    }
    catch (err)
    {
      if (signal?.aborted) throw err
    }
    return {
      contextLength: Math.min(nativeInput, this.settings.maxContextTokens),
      hosted: { maxOutputTokens },
    }
  }

  async listModels(signal?: AbortSignal): Promise<Model[]>
  {
    try
    {
      const models: Model[] = []
      for await (const info of this.sdk.models.list({}, { signal }))
      {
        if (info.lifecycle === 'retired' || info.lifecycle === 'deprecated')
        {
          continue
        }
        models.push({ name: info.id, model: info.id })
      }
      return models
    }
    catch (err)
    {
      if (signal?.aborted) throw err
      throw describeError(err)
    }
  }

  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatResponse>
  {
    const stream = this.sdk.beta.messages.stream(
      toAnthropicRequest(request, this.settings.effort),
      { signal }
    )
    let settled = false
    try
    {
      for await (const event of stream)
      {
        if (signal?.aborted) return
        if (event.type !== 'content_block_delta') continue
        if (event.delta.type === 'text_delta' && event.delta.text)
        {
          yield {
            message: { role: 'assistant', content: event.delta.text },
            done: false,
          }
        }
        else if (
          event.delta.type === 'thinking_delta' &&
          event.delta.thinking
        )
        {
          yield {
            message: {
              role: 'assistant',
              content: '',
              thinking: event.delta.thinking,
            },
            done: false,
          }
        }
      }
      const final = await stream.finalMessage()
      settled = true
      if (signal?.aborted) return
      yield finalChunkFrom(final, request.model)
    }
    catch (err)
    {
      settled = true
      if (signal?.aborted) return
      throw describeError(err, request.model)
    }
    finally
    {
      // stop the HTTP stream only when the consumer leaves early
      if (!settled) stream.abort()
    }
  }
}
