// src/tui/theme.ts
// role-based theme system: mutable active theme and call-time style accessors

import chalk, { type ChalkInstance } from 'chalk'
import { DEFAULT_THEME } from './themes.js'

// semantic roles; codeBg is the inline-code background
export type Role =
  | 'primary'
  | 'accent'
  | 'user'
  | 'code'
  | 'muted'
  | 'success'
  | 'warning'
  | 'error'
  | 'thinking'
  | 'codeBg'

export type RGB = { r: number; g: number; b: number }

// ansi names defer to the user's terminal scheme (adaptive theme)
export type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'blackBright'
  | 'redBright'
  | 'greenBright'
  | 'yellowBright'
  | 'blueBright'
  | 'magentaBright'
  | 'cyanBright'
  | 'whiteBright'

export type RoleColor = RGB | { ansi: AnsiColor }

export interface Theme
{
  // kebab-case id used by /theme and preferences
  name: string
  label: string
  description: string
  roles: Record<Role, RoleColor>
  // markdown heading roles, h1 -> h4
  headings: [Role, Role, Role, Role]
}

let active: Theme = DEFAULT_THEME
// bumped on every switch; cache keys include it so styled lines re-render
let generation = 0

export function getTheme(): Theme
{
  return active
}

export function setTheme(theme: Theme): void
{
  active = theme
  generation++
}

export function getThemeGeneration(): number
{
  return generation
}

// chalk foreground style for a role, resolved at call time
export function style(role: Role): ChalkInstance
{
  const color = active.roles[role]
  return 'ansi' in color
    ? chalk[color.ansi]
    : chalk.rgb(color.r, color.g, color.b)
}

function applyBg(base: ChalkInstance, color: RoleColor): ChalkInstance
{
  if ('ansi' in color)
  {
    const key = `bg${color.ansi[0]!.toUpperCase()}${color.ansi.slice(1)}`
    return (base as unknown as Record<string, ChalkInstance>)[key]!
  }
  return base.bgRgb(color.r, color.g, color.b)
}

// chained fg+bg style for inline code spans
export function codeSpanStyle(): ChalkInstance
{
  return applyBg(style('code'), active.roles.codeBg)
}

// color value for Ink <Text> props: hex string or ansi name
export function inkColor(role: Role): string
{
  const color = active.roles[role]
  if ('ansi' in color) return color.ansi
  const hex = [color.r, color.g, color.b]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
  return `#${hex}`
}

// raw rgb for animations; null for ansi-based roles
export function roleRgb(role: Role): RGB | null
{
  const color = active.roles[role]
  return 'ansi' in color ? null : color
}

// linear interpolate between two numbers, rounded to an integer
function lerp(a: number, b: number, t: number): number
{
  return Math.round(a + (b - a) * t)
}

// linear interpolate between two RGB colors
export function lerpRgb(a: RGB, b: RGB, t: number): RGB
{
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
  }
}

// bold heading style for markdown; depths past h4 fall back to bold white
export function headingStyle(depth: number): ChalkInstance
{
  const role = active.headings[depth - 1]
  return role ? style(role).bold : chalk.bold.whiteBright
}
