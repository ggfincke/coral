// src/utils/guards.ts
// shared runtime type guards

// true for a non-null, non-array object
export function isPlainObject(
  value: unknown
): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// a finite number floored to a whole count of at least one, else undefined
export function positiveInteger(value: unknown): number | undefined
{
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const floored = Math.floor(value)
  return floored >= 1 ? floored : undefined
}
