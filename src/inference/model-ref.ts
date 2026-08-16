// src/inference/model-ref.ts
// closed-set ModelRef parse / format; the only backend-prefix parser

export const INFERENCE_BACKENDS = ['ollama', 'mlx'] as const

export type InferenceBackend = (typeof INFERENCE_BACKENDS)[number]

/**
 * Structured model identity parsed at composition roots.
 */
export interface ModelRef
{
  backend: InferenceBackend
  model: string
  canonical: string
}

const BACKEND_SET = new Set<string>(INFERENCE_BACKENDS)

// letter-only first segments are reserved as backend ids; digits or punctuation
// keep common Ollama names such as `gemma4:31b-mlx` unambiguous
const BACKEND_SHAPED_PREFIX = /^[a-z]+$/

function isClosedBackend(value: string): value is InferenceBackend
{
  return BACKEND_SET.has(value)
}

export function formatCanonical(
  backend: InferenceBackend,
  model: string
): string
{
  return `${backend}:${model}`
}

export function unknownBackendError(prefix: string): string
{
  return (
    `Unknown model backend "${prefix}". Use ollama:<name> or mlx:<name>; ` +
    `untagged names are Ollama. Ollama tags with a lowercase letter-only ` +
    `name must be explicit (for example, ollama:mistral:latest). The default ` +
    `picker model gemma4:31b-mlx is an Ollama tag, not an mlx: backend ref.`
  )
}

// parse a user-facing model string exactly once at a composition root
export function parseModelRef(raw: string): ModelRef
{
  const trimmed = raw.trim()
  if (!trimmed)
  {
    throw new Error('model must be nonempty')
  }

  const colon = trimmed.indexOf(':')
  if (colon <= 0)
  {
    if (colon === 0)
    {
      throw new Error(unknownBackendError(''))
    }
    return {
      backend: 'ollama',
      model: trimmed,
      canonical: formatCanonical('ollama', trimmed),
    }
  }

  const prefix = trimmed.slice(0, colon)
  const remainder = trimmed.slice(colon + 1)

  if (isClosedBackend(prefix))
  {
    if (!remainder)
    {
      throw new Error(
        `model ref "${trimmed}" is missing a name after "${prefix}:"`
      )
    }
    return {
      backend: prefix,
      model: remainder,
      canonical: formatCanonical(prefix, remainder),
    }
  }

  // first-colon split only for the closed set; gemma4:31b-mlx stays ollama
  if (BACKEND_SHAPED_PREFIX.test(prefix))
  {
    throw new Error(unknownBackendError(prefix))
  }

  return {
    backend: 'ollama',
    model: trimmed,
    canonical: formatCanonical('ollama', trimmed),
  }
}

export function tryParseModelRef(raw: string): ModelRef | undefined
{
  try
  {
    return parseModelRef(raw)
  }
  catch
  {
    return undefined
  }
}

// migrate model ids written before persisted backend qualification; this is
// intentionally separate from strict parsing of new user input
export function canonicalizePersistedModelRef(raw: string): string
{
  const trimmed = raw.trim()
  if (!trimmed) return trimmed

  const colon = trimmed.indexOf(':')
  const prefix = colon > 0 ? trimmed.slice(0, colon) : ''
  if (isClosedBackend(prefix))
  {
    return tryParseModelRef(trimmed)?.canonical ?? trimmed
  }
  return formatCanonical('ollama', trimmed)
}

// compare two user-facing model strings via strict canonical parsing
export function modelRefsEqual(left: string, right: string): boolean
{
  const parsedLeft = tryParseModelRef(left)
  const parsedRight = tryParseModelRef(right)
  if (!parsedLeft || !parsedRight) return left === right
  return parsedLeft.canonical === parsedRight.canonical
}

// rewrite a listed name into canonical form for a known backend
export function canonicalListedName(
  name: string,
  backend: InferenceBackend
): string
{
  const parsed = tryParseModelRef(name)
  if (parsed && parsed.backend === backend) return parsed.canonical
  return formatCanonical(backend, name)
}

export function remainderForBackend(
  model: string,
  backend: InferenceBackend
): string
{
  const ref = parseModelRef(model)
  if (ref.backend !== backend)
  {
    throw new Error(`expected a ${backend} model ref, got ${ref.canonical}`)
  }
  return ref.model
}

export function matchListedModel(
  requested: string,
  available: string[]
): { exact?: string; prefixMatches: string[] }
{
  const requestedRef = parseModelRef(requested)
  const parsed = available.map((name) => ({
    name,
    ref: tryParseModelRef(name),
  }))
  const exact = parsed.find(
    (entry) => entry.ref?.canonical === requestedRef.canonical
  )
  if (exact?.ref) return { exact: exact.ref.canonical, prefixMatches: [] }

  const prefixMatches = parsed
    .filter((entry) =>
    {
      if (!entry.ref) return entry.name.startsWith(requested)
      return (
        entry.ref.canonical.startsWith(requestedRef.canonical) ||
        (entry.ref.backend === requestedRef.backend &&
          entry.ref.model.startsWith(requestedRef.model))
      )
    })
    .map((entry) => entry.ref?.canonical ?? entry.name)
  return { prefixMatches }
}
