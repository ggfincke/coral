// src/agent/inference-client.ts
// inference transport contract owned by Agent

import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelInfo,
} from '../types/inference.js'

export interface ListModelsOptions
{
  // skip hosted listings, for callers that only need local Ollama models
  localOnly?: boolean
}

export interface AgentInferenceClient
{
  startKeepAlive(model: string): void
  showModel(model: string, signal?: AbortSignal): Promise<ModelInfo>
  listModels(
    signal?: AbortSignal,
    options?: ListModelsOptions
  ): Promise<Model[]>
  chatStream(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatResponse>
}
