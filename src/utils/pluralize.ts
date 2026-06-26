// src/utils/pluralize.ts
// count-prefixed noun pluralization

export function pluralize(
  n: number,
  singular: string,
  plural?: string
): string
{
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`
}
