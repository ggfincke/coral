// src/utils/clamp.ts
// clamp a number to an inclusive [min, max] range

export function clamp(value: number, min: number, max: number): number
{
  return Math.min(Math.max(value, min), max)
}
