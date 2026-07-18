// src/tui/transcript/shimmer.ts
// cosine-falloff shimmer animation for terminal text

import chalk from 'chalk'
import { lerpRgb, roleRgb, style } from '../theme.js'

// shimmer band half-width in characters
const BAND_HALF_WIDTH = 5
// padding chars so the sweep enters/exits smoothly
const PADDING = 10
// full cycle duration in seconds
const CYCLE_SECONDS = 1.8

// render a string with a cosine-falloff shimmer sweep at the given time
// elapsed is in milliseconds
export function shimmerText(text: string, elapsed: number): string
{
  // sweep from muted (dim neutral) to primary (highlight)
  const base = roleRgb('muted')
  const highlight = roleRgb('primary')

  // ansi-based themes have no rgb endpoints to interpolate -> render static
  if (!base || !highlight) return style('muted')(text)

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

    // clamp and scale down slightly so the base color remains visible
    const intensity = Math.min(t, 1.0) * 0.9

    const { r, g, b } = lerpRgb(base, highlight, intensity)

    result += chalk.rgb(r, g, b)(ch)
  }

  return result
}
