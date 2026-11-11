// src/config/context.ts
// memory-aware context-window sizing

import { loadProjectConfig, loadUserConfig } from './project-config.js'
import { modelLookupKey } from '../ollama/model-name.js'
import type { Model, ModelInfo } from '../types/inference.js'
import { isPlainObject } from '../utils/guards.js'
import type { MemoryBudget, MemoryKind } from './memory-budget.js'

// reserve a fixed fraction of unified memory for the GPU on Apple Silicon
const USABLE_MEMORY_FRACTION = 0.75

// reserve memory for weights, KV cache, compute buffers, Ollama, and the OS
const MEMORY_RESERVE_BYTES = 6 * 1024 ** 3

// dedicated VRAM only needs room for the CUDA context, compute graph, and any
// display server sharing the GPU
const DISCRETE_RESERVE_BYTES = 2 * 1024 ** 3

// estimate KV elements at f16 width unless the user says the server runs a
// quantized cache, so the memory bound stays conservative by default
const F16_KV_ELEMENT_BYTES = 2

// bytes per KV element for each OLLAMA_KV_CACHE_TYPE value; the quantized
// types store 32 values per block plus a 2-byte scale
const KV_ELEMENT_BYTES: ReadonlyMap<string, number> = new Map([
  ['f16', F16_KV_ELEMENT_BYTES],
  ['q8_0', 34 / 32],
  ['q4_0', 18 / 32],
])

// keep a tight memory budget from producing an unusable context window
export const MIN_NUM_CTX = 8_192

// round the pinned window down for predictable KV allocation
const NUM_CTX_GRANULARITY = 1_024

// pin sliding-window architectures to their native window because their GGUF
// metadata overstates long-context KV use when treated as full attention
const SLIDING_WINDOW_ARCHS = new Set(['gemma', 'gemma2', 'gemma3', 'gemma4'])

export interface ContextConfig
{
  // explicit ceiling from the environment or .coral.json
  maxNumCtx?: number
  // local prompt ceiling, independent of the pinned context window
  maxPromptTokens?: number
}

export interface ContextWindowResolverDependencies
{
  model: string
  cwd: string
  // awaited after the model lookups so a slow GPU probe never delays them
  memory: MemoryBudget | Promise<MemoryBudget>
  showModel: (model: string, signal?: AbortSignal) => Promise<ModelInfo>
  listModels: (signal?: AbortSignal) => Promise<Model[]>
}

export interface ResolvedContextWindow
{
  contextWindow: number
  nativeContext: number
  memoryCap: number
  weightBytes: number
  maxNumCtx?: number
  // set for hosted APIs, which size the response separately from the window
  hostedOutputTokens?: number
  // uncapped hosted model limit, for explaining a capped window
  hostedNativeContext?: number
}

function envNumCtx(): number | undefined
{
  const env = Number.parseInt(process.env.CORAL_NUM_CTX ?? '', 10)
  return Number.isFinite(env) && env > 0 ? env : undefined
}

// resolve independent context and local prompt ceilings, preferring the environment
export function resolveContextConfig(cwd: string): ContextConfig
{
  const raw = loadProjectConfig(cwd).context
  const config: ContextConfig = {}
  for (const key of ['maxNumCtx', 'maxPromptTokens'] as const)
  {
    const env =
      key === 'maxNumCtx'
        ? envNumCtx()
        : Number.parseInt(process.env.CORAL_MAX_PROMPT_TOKENS ?? '', 10)
    const configured = isPlainObject(raw) ? raw[key] : undefined
    const value =
      typeof env === 'number' && Number.isFinite(env) && env > 0
        ? env
        : configured
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1)
    {
      config[key] = Math.floor(value)
    }
  }

  return config
}

// read the KV cache type the user declares for their Ollama server in
// ~/.coral.json ollama.kvCacheType; Coral cannot see the server's own
// environment, and anything unrecognized falls back to f16
export function resolveKvElementBytes(): number
{
  const raw = loadUserConfig().ollama
  const type =
    isPlainObject(raw) && typeof raw.kvCacheType === 'string'
      ? raw.kvCacheType.trim().toLowerCase()
      : ''
  return KV_ELEMENT_BYTES.get(type) ?? F16_KV_ELEMENT_BYTES
}

// estimate full-attention KV-cache bytes per token, or return undefined when
// the model metadata cannot describe a meaningful KV bound
export function estimateKvBytesPerToken(
  info: ModelInfo,
  elementBytes = F16_KV_ELEMENT_BYTES
): number | undefined
{
  // treat sliding-window families as KV-light so callers pin their native window
  if (info.architecture && SLIDING_WINDOW_ARCHS.has(info.architecture))
  {
    return undefined
  }

  const { blockCount, kvHeadCount, keyLength, valueLength } = info
  if (!blockCount || !kvHeadCount || !keyLength || !valueLength)
  {
    return undefined
  }

  const perLayer = kvHeadCount * (keyLength + valueLength) * elementBytes
  return blockCount * perLayer
}

export interface BudgetInputs
{
  totalMemBytes: number
  // defaults to unified memory
  memoryKind?: MemoryKind
  weightBytes: number
  nativeContext: number
  // undefined means the KV bound cannot be estimated
  kvBytesPerToken?: number
}

// choose the largest context window that fits memory and the native limit
export function computeMemoryCappedContext(inputs: BudgetInputs): number
{
  const { totalMemBytes, weightBytes, nativeContext, kvBytesPerToken } = inputs
  const forKv =
    inputs.memoryKind === 'discrete'
      ? totalMemBytes - weightBytes - DISCRETE_RESERVE_BYTES
      : totalMemBytes * USABLE_MEMORY_FRACTION -
        weightBytes -
        MEMORY_RESERVE_BYTES

  // fall back to the minimum when weights and reserve already exhaust memory
  if (forKv <= 0) return MIN_NUM_CTX

  // sliding-window or unknown-KV models use the native window after the weight check
  if (kvBytesPerToken === undefined || kvBytesPerToken <= 0)
  {
    return nativeContext
  }

  const byMemory = Math.floor(forKv / kvBytesPerToken)
  const capped = Math.max(MIN_NUM_CTX, Math.min(nativeContext, byMemory))
  return roundDownToGranularity(capped)
}

// resolve the pinned context window from model metadata and local config
export async function resolvePinnedContextWindow(
  deps: ContextWindowResolverDependencies,
  signal?: AbortSignal
): Promise<ResolvedContextWindow | undefined>
{
  let info: ModelInfo
  try
  {
    info = await deps.showModel(deps.model, signal)
  }
  catch (err)
  {
    if (signal?.aborted) throw err
    return undefined
  }

  if (info.contextLength <= 0) return undefined

  const nativeContext = info.contextLength
  // hosted windows arrive already capped by the provider's cost ceiling, so
  // only the explicit environment override narrows them further; project
  // ceilings exist for local memory and do not apply
  if (info.hosted)
  {
    const maxNumCtx = envNumCtx()
    const contextWindow = Math.min(
      nativeContext,
      Math.max(MIN_NUM_CTX, maxNumCtx ?? Number.POSITIVE_INFINITY)
    )
    return {
      contextWindow,
      nativeContext,
      memoryCap: nativeContext,
      weightBytes: 0,
      maxNumCtx,
      hostedOutputTokens: info.hosted.maxOutputTokens,
      hostedNativeContext: info.hosted.nativeContextTokens,
    }
  }
  const maxNumCtx = resolveContextConfig(deps.cwd).maxNumCtx
  const weightBytes = await resolveModelWeightBytes(
    deps.model,
    deps.listModels,
    signal
  )
  const memory = await deps.memory
  const memoryCap = computeMemoryCappedContext({
    totalMemBytes: memory.totalBytes,
    memoryKind: memory.kind,
    weightBytes,
    nativeContext,
    kvBytesPerToken: estimateKvBytesPerToken(info, resolveKvElementBytes()),
  })

  // enforce the minimum and native bounds after applying the user ceiling
  const budget = Math.min(memoryCap, maxNumCtx ?? Number.POSITIVE_INFINITY)
  const contextWindow = Math.min(nativeContext, Math.max(MIN_NUM_CTX, budget))

  return {
    contextWindow,
    nativeContext,
    memoryCap,
    weightBytes,
    maxNumCtx,
  }
}

// round down to the context granularity without rounding small values to zero
function roundDownToGranularity(value: number): number
{
  if (value <= NUM_CTX_GRANULARITY) return value
  return Math.floor(value / NUM_CTX_GRANULARITY) * NUM_CTX_GRANULARITY
}

// look up active model weight size, treating unknown sizes as zero
async function resolveModelWeightBytes(
  model: string,
  listModels: (signal?: AbortSignal) => Promise<Model[]>,
  signal?: AbortSignal
): Promise<number>
{
  try
  {
    const models = await listModels(signal)
    const exact = models.find((candidate) => candidate.name === model)
    if (exact) return exact.size ?? 0

    const key = modelLookupKey(model)
    let weightBytes = 0
    for (const candidate of models)
    {
      const matches = [candidate.name, candidate.model].some(
        (name) => typeof name === 'string' && modelLookupKey(name) === key
      )
      const size = candidate.size ?? 0
      if (matches && Number.isFinite(size) && size >= 0)
      {
        // ambiguous aliases use the conservative weight without selecting a model
        weightBytes = Math.max(weightBytes, size)
      }
    }
    return weightBytes
  }
  catch (err)
  {
    if (signal?.aborted) throw err
    return 0
  }
}
