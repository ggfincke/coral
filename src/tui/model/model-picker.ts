// src/tui/model/model-picker.ts
// format startup model selection for the TUI

import chalk from 'chalk'
import type { Model } from '../../types/inference.js'
import { formatBytes } from '../../utils/bytes.js'
import { clamp } from '../../utils/clamp.js'
import { style } from '../theme.js'
import { wrapLines } from '../wrap.js'

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
  if (models.length === 0)
  {
    return [
      style('error').bold('No Ollama models found'),
      chalk.dim('Pull a model or pass --model explicitly.'),
    ]
  }

  const wrapWidth = Math.max(width, 16)
  const visibleCount = Math.max(height - 6, 3)
  const start = clamp(
    selectedIndex - Math.floor(visibleCount / 2),
    0,
    Math.max(models.length - visibleCount, 0)
  )
  const end = Math.min(start + visibleCount, models.length)
  const selected = models[Math.min(selectedIndex, models.length - 1)]!
  const lines: string[] = [
    style('primary').bold('Select an Ollama model'),
    chalk.dim('enter selects · ↑↓ or j/k moves · esc quits'),
    '',
  ]

  for (let index = start; index < end; index += 1)
  {
    const model = models[index]!
    const prefix =
      index === selectedIndex ? style('primary')('›') : chalk.dim(' ')
    const name =
      index === selectedIndex ? style('user')(model.name) : model.name
    lines.push(...wrapLines(`${prefix} ${name}`, wrapWidth))
  }

  lines.push('')
  lines.push(...wrapLines(chalk.dim(`Selected: ${selected.name}`), wrapWidth))
  lines.push(
    ...wrapLines(chalk.dim(`Size: ${formatBytes(selected.size)}`), wrapWidth)
  )
  lines.push(
    ...wrapLines(chalk.dim(`Modified: ${selected.modified_at}`), wrapWidth)
  )

  if (models.length > visibleCount)
  {
    lines.push('')
    lines.push(chalk.dim(`Showing ${start + 1}-${end} of ${models.length}`))
  }

  return lines
}
