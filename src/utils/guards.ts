// src/utils/guards.ts
// shared runtime type guards

// true for a non-null, non-array object
export function isPlainObject(
  value: unknown
): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
