// src/providers/openai/client.ts
// stream OpenAI models through the stateless Responses API

import OpenAI from 'openai'
import type { AgentInferenceClient } from '../../agent/inference-client.js'
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelInfo,
} from '../../types/inference.js'
import type { HostedProviderSettings } from '../config.js'
import {
  finalChunkFrom,
  isOpenAIChatModel,
  openAIModelLimits,
  toOpenAIModel,
  toOpenAIRequest,
} from './wire.js'

// translate SDK failures into short actionable text without request bodies
function describeError(err: unknown, model?: string): Error
{
  if (err instanceof OpenAI.AuthenticationError)
  {
    return new Error('OpenAI rejected OPENAI_API_KEY (401)')
  }
  if (err instanceof OpenAI.PermissionDeniedError)
  {
    return new Error(
      'OpenAI denied access (403); check the key has API credits'
    )
  }
  if (err instanceof OpenAI.NotFoundError)
  {
    return new Error(
      `OpenAI has no model ${model ? `"${model}"` : 'by that name'} (404)`
    )
  }
  if (err instanceof OpenAI.RateLimitError)
  {
    return new Error('OpenAI rate limit or quota hit (429); retry shortly')
  }
  if (err instanceof OpenAI.APIConnectionError)
  {
    return new Error(`Cannot reach the OpenAI API: ${err.message}`)
  }
  if (err instanceof OpenAI.APIError)
  {
    return new Error(`OpenAI API error ${err.status ?? ''}: ${err.message}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Hosted inference client for OpenAI models. Runs every request with
 * `store: false` and carries encrypted reasoning items through Coral history
 * so reasoning survives across tool rounds without server-side state.
 */
export class OpenAIClient implements AgentInferenceClient
{
  private readonly sdk: OpenAI
  private readonly settings: HostedProviderSettings

  constructor(settings: HostedProviderSettings)
  {
    this.settings = settings
    this.sdk = new OpenAI({ apiKey: settings.apiKey })
  }

  // hosted models have no runner residency to manage
  startKeepAlive(): void
  {}

  // the Models API has no limits, so they come from the published table
  async showModel(model: string): Promise<ModelInfo>
  {
    const limits = openAIModelLimits(model)
    return {
      contextLength: Math.min(
        limits.contextLength,
        this.settings.maxContextTokens
      ),
      hosted: { maxOutputTokens: limits.maxOutputTokens },
    }
  }

  async listModels(signal?: AbortSignal): Promise<Model[]>
  {
    try
    {
      const models: Model[] = []
      for await (const info of this.sdk.models.list({ signal }))
      {
        if (isOpenAIChatModel(info.id, info.shutdown_date))
        {
          models.push(toOpenAIModel(info.id))
        }
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
    const stream = this.sdk.responses.stream(
      toOpenAIRequest(request, this.settings.effort),
      { signal }
    )
    let settled = false
    try
    {
      for await (const event of stream)
      {
        if (signal?.aborted) return
        if (event.type === 'response.output_text.delta' && event.delta)
        {
          yield {
            message: { role: 'assistant', content: event.delta },
            done: false,
          }
        }
        else if (
          event.type === 'response.reasoning_summary_text.delta' &&
          event.delta
        )
        {
          yield {
            message: { role: 'assistant', content: '', thinking: event.delta },
            done: false,
          }
        }
      }
      const final = await stream.finalResponse()
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
