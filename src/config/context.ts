// src/config/context.ts
// memory-aware context-window sizing

import { loadProjectConfig } from './project-config.js'
import type { Model, ModelInfo } from '../types/inference.js'
import { isPlainObject } from '../utils/guards.js'

// reserve a fixed fraction of unified memory for the GPU on Apple Silicon
const USABLE_MEMORY_FRACTION = 0.75

// reserve memory for weights, KV cache, compute buffers, Ollama, and the OS
const MEMORY_RESERVE_BYTES = 6 * 1024 ** 3

// estimate KV elements at f16 width so the memory bound stays conservative
const KV_ELEMENT_BYTES = 2

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
}

export interface ContextWindowResolverDependencies
{
  model: string
  cwd: string
  totalMemBytes: number
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
}

// resolve the explicit context ceiling, with the environment taking precedence
export function resolveContextConfig(cwd: string): ContextConfig
{
  const env = Number.parseInt(process.env.CORAL_NUM_CTX ?? '', 10)
  if (Number.isFinite(env) && env > 0) return { maxNumCtx: env }

  const raw = loadProjectConfig(cwd).context
  const configured = isPlainObject(raw) ? raw.maxNumCtx : undefined
  if (typeof configured === 'number' && configured > 0)
  {
    return { maxNumCtx: Math.floor(configured) }
  }

  return {}
}

// estimate full-attention KV-cache bytes per token, or return undefined when
// the model metadata cannot describe a meaningful KV bound
export function estimateKvBytesPerToken(info: ModelInfo): number | undefined
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

  const perLayer = kvHeadCount * (keyLength + valueLength) * KV_ELEMENT_BYTES
  return blockCount * perLayer
}

export interface BudgetInputs
{
  totalMemBytes: number
  weightBytes: number
  nativeContext: number
  // undefined means the KV bound cannot be estimated
  kvBytesPerToken?: number
}

// choose the largest context window that fits memory and the native limit
export function computeMemoryCappedContext(inputs: BudgetInputs): number
{
  const { totalMemBytes, weightBytes, nativeContext, kvBytesPerToken } = inputs
  const usable = totalMemBytes * USABLE_MEMORY_FRACTION
  const forKv = usable - weightBytes - MEMORY_RESERVE_BYTES

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
  const maxNumCtx = resolveContextConfig(deps.cwd).maxNumCtx
  const weightBytes = await resolveModelWeightBytes(
    deps.model,
    deps.listModels,
    signal
  )
  const memoryCap = computeMemoryCappedContext({
    totalMemBytes: deps.totalMemBytes,
    weightBytes,
    nativeContext,
    kvBytesPerToken: estimateKvBytesPerToken(info),
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
    return models.find((candidate) => candidate.name === model)?.size ?? 0
  }
  catch (err)
  {
    if (signal?.aborted) throw err
    return 0
  }
}
