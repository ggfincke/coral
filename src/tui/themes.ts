// src/tui/themes.ts
// built-in theme definitions & lookup

import type { Theme } from './theme.js'

const CORAL_REEF: Theme = {
  name: 'coral-reef',
  label: 'Coral Reef',
  description: 'warm coral & ocean teal (default)',
  roles: {
    primary: { r: 255, g: 127, b: 80 },
    accent: { r: 255, g: 160, b: 170 },
    user: { r: 0, g: 190, b: 180 },
    code: { r: 90, g: 150, b: 200 },
    muted: { r: 180, g: 160, b: 140 },
    success: { r: 95, g: 200, b: 120 },
    warning: { r: 235, g: 180, b: 60 },
    error: { r: 235, g: 90, b: 80 },
    thinking: { r: 215, g: 130, b: 200 },
    codeBg: { r: 30, g: 40, b: 50 },
  },
  headings: ['primary', 'user', 'accent', 'code'],
}

const DEEP_SEA: Theme = {
  name: 'deep-sea',
  label: 'Deep Sea',
  description: 'bioluminescent cyan & violet for dark terminals',
  roles: {
    primary: { r: 122, g: 231, b: 255 },
    accent: { r: 184, g: 156, b: 255 },
    user: { r: 63, g: 224, b: 208 },
    code: { r: 90, g: 124, b: 200 },
    muted: { r: 92, g: 107, b: 130 },
    success: { r: 95, g: 220, b: 160 },
    warning: { r: 255, g: 200, b: 90 },
    error: { r: 255, g: 110, b: 110 },
    thinking: { r: 150, g: 130, b: 220 },
    codeBg: { r: 16, g: 28, b: 44 },
  },
  headings: ['primary', 'user', 'accent', 'code'],
}

const SUNSET_TIDE: Theme = {
  name: 'sunset-tide',
  label: 'Sunset Tide',
  description: 'warm coral, pink & amber',
  roles: {
    primary: { r: 255, g: 107, b: 90 },
    accent: { r: 255, g: 77, b: 141 },
    user: { r: 255, g: 179, b: 71 },
    code: { r: 200, g: 75, b: 49 },
    muted: { r: 184, g: 154, b: 140 },
    success: { r: 170, g: 210, b: 110 },
    warning: { r: 255, g: 190, b: 80 },
    error: { r: 255, g: 85, b: 85 },
    thinking: { r: 240, g: 120, b: 170 },
    codeBg: { r: 45, g: 28, b: 24 },
  },
  headings: ['primary', 'user', 'accent', 'code'],
}

const KELP_FOREST: Theme = {
  name: 'kelp-forest',
  label: 'Kelp Forest',
  description: 'greens, teals & earthy sand',
  roles: {
    primary: { r: 46, g: 168, b: 138 },
    accent: { r: 163, g: 217, b: 107 },
    user: { r: 63, g: 191, b: 160 },
    code: { r: 74, g: 122, b: 85 },
    muted: { r: 138, g: 148, b: 118 },
    success: { r: 120, g: 220, b: 130 },
    warning: { r: 220, g: 190, b: 80 },
    error: { r: 225, g: 100, b: 90 },
    thinking: { r: 170, g: 160, b: 200 },
    codeBg: { r: 24, g: 38, b: 30 },
  },
  headings: ['primary', 'user', 'accent', 'code'],
}

const TIDE_POOL: Theme = {
  name: 'tide-pool',
  label: 'Tide Pool',
  description: 'soft pastel pinks, teals & lavender',
  roles: {
    primary: { r: 242, g: 166, b: 194 },
    accent: { r: 201, g: 166, b: 232 },
    user: { r: 143, g: 217, b: 208 },
    code: { r: 166, g: 184, b: 232 },
    muted: { r: 154, g: 160, b: 168 },
    success: { r: 150, g: 215, b: 170 },
    warning: { r: 240, g: 205, b: 130 },
    error: { r: 240, g: 140, b: 140 },
    thinking: { r: 190, g: 150, b: 220 },
    codeBg: { r: 36, g: 36, b: 46 },
  },
  headings: ['primary', 'user', 'accent', 'code'],
}

const ADAPTIVE: Theme = {
  name: 'adaptive',
  label: 'Adaptive',
  description: "inherits your terminal's ANSI palette",
  roles: {
    primary: { ansi: 'magenta' },
    accent: { ansi: 'magentaBright' },
    user: { ansi: 'cyan' },
    code: { ansi: 'blue' },
    muted: { ansi: 'gray' },
    success: { ansi: 'green' },
    warning: { ansi: 'yellow' },
    error: { ansi: 'red' },
    thinking: { ansi: 'magenta' },
    codeBg: { ansi: 'blackBright' },
  },
  headings: ['primary', 'user', 'accent', 'code'],
}

export const THEMES: readonly Theme[] = [
  CORAL_REEF,
  DEEP_SEA,
  SUNSET_TIDE,
  KELP_FOREST,
  TIDE_POOL,
  ADAPTIVE,
]

export const DEFAULT_THEME = CORAL_REEF

// case-insensitive lookup by id or label
export function findTheme(name: string): Theme | undefined
{
  const needle = name.trim().toLowerCase()
  return THEMES.find(
    (theme) => theme.name === needle || theme.label.toLowerCase() === needle
  )
}
