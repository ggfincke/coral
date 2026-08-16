// src/tools/search-code-deps.ts
// bind search retrieval providers at composition roots

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  formatWorkerInstallError,
  resolveInferenceConfig,
} from '../config/inference.js'
import { parseModelRef } from '../inference/model-ref.js'
import { PythonEmbedder } from '../inference/python-embedder.js'
import type { WorkerSupervisor } from '../inference/worker-supervisor.js'
import { OllamaClient } from '../ollama/client.js'
import { DEFAULT_OLLAMA_HOST } from '../ollama/host.js'
import type { RetrievalDeps } from '../retrieval/build.js'
import {
  createMlxEmbeddingSpace,
  resolveOllamaEmbeddingSpace,
} from '../retrieval/embedding-space.js'
import { OllamaEmbedder } from '../retrieval/ollama-embedder.js'
import type { Tool } from './tool.js'
import { createSearchCodeTool } from './search-code.js'

export function mlxEmbeddingEndpointIdentity(): string
{
  const configured = resolveInferenceConfig().mlxModelsDir
  const absolute = resolve(configured ?? `${homedir()}/.coral/mlx-models`)
  try
  {
    return realpathSync(absolute)
  }
  catch
  {
    return absolute
  }
}

// composition-root retrieval deps: mlx uses the shared worker; ollama stays HTTP
export function createRetrievalDeps(
  options: {
    worker?: WorkerSupervisor
  } = {}
): RetrievalDeps
{
  const worker = options.worker
  const endpointIdentity = mlxEmbeddingEndpointIdentity()
  return {
    resolveSpace: async (client, host, embeddingModel, signal) =>
    {
      const ref = parseModelRef(embeddingModel)
      if (ref.backend === 'ollama')
      {
        return resolveOllamaEmbeddingSpace(client, host, ref.model, signal)
      }
      if (!worker)
      {
        throw new Error(formatWorkerInstallError())
      }
      await worker.ensure(signal)
      const shown = await worker.request(
        'model.show',
        { name: ref.model },
        signal
      )
      const digest = shown.digest
      if (typeof digest !== 'string')
      {
        throw new Error(
          'mlx embedding model identity requires a 64-character SHA-256 digest from model.show'
        )
      }
      return createMlxEmbeddingSpace({
        endpointIdentity,
        artifactDigest: digest,
        displayModel: ref.model,
      })
    },
    createEmbedder: (space, signal) =>
    {
      if (space.provider === 'mlx')
      {
        if (!worker) throw new Error(formatWorkerInstallError())
        return new PythonEmbedder(worker, space, signal)
      }
      const host = space.endpointIdentity ?? DEFAULT_OLLAMA_HOST
      return new OllamaEmbedder(new OllamaClient(host), space, signal)
    },
  }
}

export function replaceSearchCodeTool(
  tools: readonly Tool[],
  worker?: WorkerSupervisor
): Tool[]
{
  const search = createSearchCodeTool(createRetrievalDeps({ worker }))
  return tools.map((tool) => (tool.name === 'search_code' ? search : tool))
}
