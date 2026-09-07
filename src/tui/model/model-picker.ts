// src/tui/model/model-picker.ts
// format startup model selection for the TUI

import chalk from 'chalk'
import type { Model } from '../../types/inference.js'
import { formatBytes } from '../../utils/bytes.js'
import { clamp } from '../../utils/clamp.js'
import { selectionStyle, style } from '../theme.js'
import { sanitizeUntrustedText } from '../transcript/sanitize.js'
import { padEnd, truncateLine, visibleWidth } from '../wrap.js'

// preferred default model, pinned to the top and selected at startup
const DEFAULT_MODEL = 'gemma4:31b-mlx'

function parseModifiedAt(value: string): number
{
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function sortModels(models: Model[]): Model[]
{
  return [...models].sort((left, right) =>
  {
    // pin the preferred default model to the top
    const leftDefault = left.name === DEFAULT_MODEL
    const rightDefault = right.name === DEFAULT_MODEL
    if (leftDefault !== rightDefault) return leftDefault ? -1 : 1

    const dateDiff =
      parseModifiedAt(right.modified_at) - parseModifiedAt(left.modified_at)
    if (dateDiff !== 0) return dateDiff
    return left.name.localeCompare(right.name)
  })
}

export function buildModelPickerLines(
  models: Model[],
  selectedIndex: number,
  width: number,
  height: number
): string[]
{
  const columns = Math.max(Math.floor(width), 0)
  const rows = Math.max(Math.floor(height), 0)
  if (columns === 0 || rows === 0) return []
  const clean = (text: string) =>
    sanitizeUntrustedText(text).replace(/\s+/g, ' ').trim()

  if (models.length === 0)
  {
    return [
      style('error').bold('No Ollama models found'),
      chalk.dim('Pull a model or pass --model explicitly.'),
    ]
      .slice(0, rows)
      .map((line) => truncateLine(line, columns))
  }

  const safeIndex = clamp(selectedIndex, 0, models.length - 1)
  const selected = models[safeIndex]!
  const lines: string[] = []
  if (rows >= 2) lines.push(style('primary').bold('Select an Ollama model'))
  if (rows >= 3)
  {
    lines.push(chalk.dim('enter selects · ↑↓ or j/k moves · esc quits'))
  }
  if (rows >= 8) lines.push('')

  const detailRows = rows >= 8 ? 3 : rows >= 5 ? 1 : 0
  const countRows =
    rows >= 6 && models.length > rows - lines.length - detailRows ? 1 : 0
  const visibleCount = Math.max(rows - lines.length - detailRows - countRows, 1)
  const start = clamp(
    safeIndex - Math.floor(visibleCount / 2),
    0,
    Math.max(models.length - visibleCount, 0)
  )
  const end = Math.min(start + visibleCount, models.length)
  for (let index = start; index < end; index += 1)
  {
    const model = models[index]!
    const active = index === safeIndex
    const size = columns >= 32 ? formatBytes(model.size) : ''
    const nameWidth = Math.max(
      columns - 3 - (size ? visibleWidth(size) + 2 : 0),
      0
    )
    const name = padEnd(truncateLine(clean(model.name), nameWidth), nameWidth)
    const row = truncateLine(
      ` ${active ? '›' : ' '} ${active ? chalk.bold(name) : name}${size ? `  ${active ? size : chalk.dim(size)}` : ''}`,
      columns
    )
    lines.push(active ? selectionStyle()(padEnd(row, columns)) : row)
  }

  if (countRows)
  {
    lines.push(chalk.dim(`Showing ${start + 1}-${end} of ${models.length}`))
  }
  if (detailRows >= 3) lines.push('')
  if (detailRows >= 1)
    lines.push(chalk.dim(`Selected: ${clean(selected.name)}`))
  if (detailRows >= 3)
  {
    lines.push(
      chalk.dim(
        `Size: ${formatBytes(selected.size)} · Modified: ${clean(selected.modified_at)}`
      )
    )
  }

  return lines.slice(0, rows).map((line) => truncateLine(line, columns))
}
