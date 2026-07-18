// src/config/context.ts
// memory-aware num_ctx sizing — pin the largest context window that fits the
// host's memory budget, capped by the model's native window & any user override

import { loadProjectConfig } from './project-config.js'
import type { Model, ModelInfo } from '../types/inference.js'
import { isPlainObject } from '../utils/guards.js'

// fraction of unified memory the GPU may wire by default on Apple Silicon
// (~75% above 32GiB); the remainder is left for the OS & other apps
const USABLE_MEMORY_FRACTION = 0.75

// headroom reserved on top of weights + KV for compute/activation buffers,
// the Ollama runtime, & the OS
const MEMORY_RESERVE_BYTES = 6 * 1024 ** 3

// KV cache element size — Ollama defaults to f16 (2 bytes). using the
// unquantized size keeps the estimate conservative (real KV may be 8-bit)
const KV_ELEMENT_BYTES = 2

// floor for the pinned window so a tight budget never yields an unusable ctx
export const MIN_NUM_CTX = 8_192

// round the pinned window down to this granularity for tidy KV allocation
const NUM_CTX_GRANULARITY = 1_024

// architectures w/ interleaved sliding-window attention — KV is dominated by a
// few global layers & stays small at long context, but gguf metadata reports
// only the per-layer dims, which over-counts KV ~6x if treated as full
// attention. pin native for these instead of trusting the inflated estimate
const SLIDING_WINDOW_ARCHS = new Set(['gemma', 'gemma2', 'gemma3', 'gemma4'])

export interface ContextConfig
{
  // explicit ceiling from env or .coral.json; undefined when unset
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

// resolve an explicit num_ctx ceiling — env wins, then .coral.json. undefined
// means "no override", so the memory budget decides the window
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

// estimate full-attention KV-cache bytes per token across all layers. returns
// undefined when the model omits KV dims — gemma exposes no kv-head count in
// Ollama metadata, & such models are sliding-window & KV-light, so the caller
// treats undefined as "no KV-memory constraint"
export function estimateKvBytesPerToken(info: ModelInfo): number | undefined
{
  // sliding-window families under-report KV as full-attention dims; treat them
  // as KV-light so the caller pins native instead of over-estimating
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
  // undefined => KV not estimable (sliding-window family); skip the KV bound
  kvBytesPerToken?: number
}

// largest num_ctx that fits the memory budget, capped to the native window.
// KV-estimable models are bounded by available KV memory; KV-light models pin
// native as long as their weights fit
export function computeMemoryCappedContext(inputs: BudgetInputs): number
{
  const { totalMemBytes, weightBytes, nativeContext, kvBytesPerToken } = inputs
  const usable = totalMemBytes * USABLE_MEMORY_FRACTION
  const forKv = usable - weightBytes - MEMORY_RESERVE_BYTES

  // weights + reserve already overflow the budget — fall back to the floor
  if (forKv <= 0) return MIN_NUM_CTX

  // ! sliding-window / unknown-KV model: SWA keeps KV small, so pin native &
  // ! rely only on the weights-fit check above. set an explicit override on a
  // ! memory-constrained host if this proves too aggressive
  if (kvBytesPerToken === undefined || kvBytesPerToken <= 0)
  {
    return nativeContext
  }

  const byMemory = Math.floor(forKv / kvBytesPerToken)
  const capped = Math.max(MIN_NUM_CTX, Math.min(nativeContext, byMemory))
  return roundDownToGranularity(capped)
}

// resolve the pinned num_ctx from live model metadata & local config
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

  // floor the budget (incl. a too-small user override) at MIN_NUM_CTX, then
  // clamp to native so a tiny-context model is never pinned above its window
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

// round down to the ctx granularity, but never below the granularity itself
function roundDownToGranularity(value: number): number
{
  if (value <= NUM_CTX_GRANULARITY) return value
  return Math.floor(value / NUM_CTX_GRANULARITY) * NUM_CTX_GRANULARITY
}

// look up active model weight size; unknown means "ignore weights"
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
