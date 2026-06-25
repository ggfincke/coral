// src/tui/welcome.ts
// startup welcome splash: pixel-coral logo + wordmark, theme-tinted

import chalk, { type ChalkInstance } from 'chalk'
import { homedir } from 'node:os'
import { lerpRgb, roleRgb, style, type RGB } from './theme.js'
import { center, visibleWidth } from './wrap.js'

// pixel grids: '#' = coral cell, '.' = empty. each cell -> a 2-col block so it reads square
const CORAL_FULL = [
  '..........##..........',
  '.......##.######......',
  '.......#########......',
  '.....##.#######.##....',
  '.....##.#######.##....',
  '...##.##.#####.##.##..',
  '...##.##.#####.##.##..',
  '....##.##.######.##...',
  '....##.##.######.##...',
  '..##################..',
  '...################...',
]

const CORAL_COMPACT = [
  '..........##..........',
  '.......##.######......',
  '.......##.######......',
  '.....##.#######.##....',
  '.....##.#######.##....',
  '......##.#####.##.....',
  '......##.#####.##.....',
  '.......##.######......',
  '..##################..',
  '...################...',
]

const BLOCK = '██'
const PIXEL_W = 2

// logo needs this many columns (grid width * 2) plus a little margin
const LOGO_COLS = CORAL_FULL[0]!.length * PIXEL_W
// chat-area rows required to fit each tier w/o crowding the prompt
const FULL_MIN_ROWS = 15
const COMPACT_MIN_ROWS = 13
// gap between the coral & the text column in the horizontal lockup
const GAP = 4

export interface WelcomeOptions
{
  width: number
  rows: number
  model?: string
  cwd: string
  // cache key — bumped on /theme switch so the splash re-tints; read live via style()
  themeGeneration: number
}

// vertical gradient endpoints: bright coral tips -> sandy base
// ansi-based themes have no rgb to interpolate -> solid primary
function makePaint(): (t: number) => ChalkInstance
{
  const top: RGB | null = roleRgb('primary')
  const bot: RGB | null = roleRgb('muted')
  if (!top || !bot) return () => style('primary')
  return (t: number) =>
  {
    const rgb = lerpRgb(top, bot, t)
    return chalk.rgb(rgb.r, rgb.g, rgb.b)
  }
}

// raw logo rows: left-aligned, each LOGO_COLS visible cols (empty cells -> spaces)
function coralLogoRows(grid: string[]): string[]
{
  const paint = makePaint()
  const height = grid.length
  return grid.map((row, y) =>
  {
    const t = height > 1 ? y / (height - 1) : 0
    const color = paint(t)
    let rendered = ''
    for (const ch of row) rendered += ch === '#' ? color(BLOCK) : '  '
    return rendered
  })
}

function shortenCwd(cwd: string): string
{
  const home = homedir()
  if (cwd === home) return '~'
  if (cwd.startsWith(home + '/')) return '~' + cwd.slice(home.length)
  return cwd
}

function wordmarkText(): string
{
  return chalk.dim('welcome to ') + style('primary').bold('coral')
}

// dim cwd · model · /help line, dropping cwd then model until it fits maxWidth
function infoText(
  cwd: string,
  model: string | undefined,
  maxWidth: number
): string
{
  let parts = [shortenCwd(cwd), model, '/help'].filter((part): part is string =>
    Boolean(part)
  )
  while (parts.length > 1 && parts.join(' · ').length > maxWidth)
    parts = parts.slice(1)
  let text = parts.join(' · ')
  // final guard for pathologically narrow widths
  if (text.length > maxWidth) text = text.slice(0, Math.max(maxWidth, 0))
  return chalk.dim(text)
}

// coral on the left, text block vertically centered to its right; unit centered
function composeHorizontal(
  logoRows: string[],
  textLines: string[],
  width: number
): string[]
{
  const textWidth = Math.max(...textLines.map((line) => visibleWidth(line)))
  const blockWidth = LOGO_COLS + GAP + textWidth
  const indent = ' '.repeat(Math.max(Math.floor((width - blockWidth) / 2), 0))
  const textTop = Math.round((logoRows.length - textLines.length) / 2)
  return logoRows.map((row, y) =>
  {
    const offset = y - textTop
    const text =
      offset >= 0 && offset < textLines.length ? textLines[offset] : ''
    return text ? indent + row + ' '.repeat(GAP) + text : indent + row
  })
}

export function buildWelcomeLines(opts: WelcomeOptions): string[]
{
  const { width, rows, model, cwd } = opts
  const wordmark = wordmarkText()

  // pick a logo grid by available height; null -> text-only
  const fits = width >= LOGO_COLS + 2
  let grid: string[] | null = null
  if (fits && rows >= FULL_MIN_ROWS) grid = CORAL_FULL
  else if (fits && rows >= COMPACT_MIN_ROWS) grid = CORAL_COMPACT

  if (!grid)
  {
    const info = infoText(cwd, model, width)
    return [center(wordmark, width), center(info, width)]
  }

  const logoRows = coralLogoRows(grid)
  const textColWidth = width - LOGO_COLS - GAP

  // wide enough to seat the text beside the coral -> horizontal lockup
  if (textColWidth >= visibleWidth(wordmark))
  {
    const info = infoText(cwd, model, textColWidth)
    return composeHorizontal(logoRows, [wordmark, info], width)
  }

  // too narrow for side-by-side -> stack the text under a centered logo
  const info = infoText(cwd, model, width)
  return [
    ...logoRows.map((row) => center(row, width)),
    '',
    center(wordmark, width),
    center(info, width),
  ]
}
