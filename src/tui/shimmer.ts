// src/tui/shimmer.ts
// cosine-falloff shimmer animation for terminal text

import chalk from 'chalk'
import { SAND, CORAL } from './theme.js'

// shimmer sweeps from sand (dim neutral) to coral (warm pink-orange)
const BASE_COLOR = SAND
const HIGHLIGHT_COLOR = CORAL

// shimmer band half-width in characters
const BAND_HALF_WIDTH = 5
// padding chars so the sweep enters/exits smoothly
const PADDING = 10
// full cycle duration in seconds
const CYCLE_SECONDS = 1.8

function lerp(a: number, b: number, t: number): number
{
  return Math.round(a + (b - a) * t)
}

// render a string w/ a cosine-falloff shimmer sweep at the given time
// elapsed is in milliseconds
export function shimmerText(text: string, elapsed: number): string
{
  const chars = [...text]
  const period = chars.length + PADDING * 2
  const pos = (((elapsed / 1000) % CYCLE_SECONDS) / CYCLE_SECONDS) * period

  let result = ''

  for (let i = 0; i < chars.length; i++)
  {
    const ch = chars[i]!

    // distance from sweep center (offset by padding so sweep enters from left)
    const dist = Math.abs(i + PADDING - pos)

    let t: number
    if (dist <= BAND_HALF_WIDTH)
    {
      // cosine falloff: 1.0 at center, 0.0 at edge
      const x = Math.PI * (dist / BAND_HALF_WIDTH)
      t = 0.5 * (1.0 + Math.cos(x))
    }
    else
    {
      t = 0
    }

    // clamp & scale down slightly so base color is always visible
    const intensity = Math.min(t, 1.0) * 0.9

    const r = lerp(BASE_COLOR.r, HIGHLIGHT_COLOR.r, intensity)
    const g = lerp(BASE_COLOR.g, HIGHLIGHT_COLOR.g, intensity)
    const b = lerp(BASE_COLOR.b, HIGHLIGHT_COLOR.b, intensity)

    result += chalk.rgb(r, g, b)(ch)
  }

  return result
}
