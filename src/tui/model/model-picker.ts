// src/tui/model/model-picker.ts
// format startup model selection for the TUI

import chalk from 'chalk'
import { tryParseModelRef } from '../../inference/model-ref.js'
import type { Model } from '../../types/inference.js'
import { formatBytes } from '../../utils/bytes.js'
import { clamp } from '../../utils/clamp.js'
import { ellipsize } from '../../utils/ellipsize.js'
import { sanitizeUntrustedText } from '../../utils/untrusted-text.js'
import { style } from '../theme.js'
import { wrapLines } from '../wrap.js'

// preferred default model, pinned to the top and selected at startup.
// this is an Ollama tag; the -mlx suffix is not the mlx: backend prefix.
const DEFAULT_MODEL = 'gemma4:31b-mlx'
const MAX_WARNING_LINES = 2

function parseModifiedAt(value: string): number
{
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function isDefaultModel(name: string): boolean
{
  const ref = tryParseModelRef(name)
  const defaultRef = tryParseModelRef(DEFAULT_MODEL)
  if (!ref || !defaultRef) return name === DEFAULT_MODEL
  return ref.canonical === defaultRef.canonical
}

export function formatPickerModelName(model: Model): string
{
  const ref = tryParseModelRef(model.name)
  if (!ref) return model.name
  return `${ref.model}  (${ref.backend})`
}

export function sortModels(models: Model[]): Model[]
{
  return [...models].sort((left, right) =>
  {
    const leftDefault = isDefaultModel(left.name)
    const rightDefault = isDefaultModel(right.name)
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
  height: number,
  warning?: string
): string[]
{
  if (models.length === 0)
  {
    return [
      style('error').bold('No models found'),
      chalk.dim('Pull an Ollama model, add mlx: weights, or pass --model.'),
    ]
  }

  const wrapWidth = Math.max(width, 16)
  const viewportHeight = Math.max(Math.floor(height), 4)
  const safeSelectedIndex = clamp(selectedIndex, 0, models.length - 1)
  const selected = models[safeSelectedIndex]!
  const header = [
    style('primary').bold('Select a model'),
    chalk.dim('enter selects · ↑↓ or j/k moves · esc quits'),
    '',
  ]
  const contentRows = Math.max(viewportHeight - header.length, 1)
  const minimumModelRows = Math.min(
    models.length,
    Math.max(Math.ceil(contentRows / 2), 1)
  )
  const footerBudget = Math.max(contentRows - minimumModelRows, 0)
  const cleanWarning = warning ? sanitizeUntrustedText(warning) : ''
  const wrappedWarning = cleanWarning
    ? wrapLines(cleanWarning, wrapWidth).slice(0, MAX_WARNING_LINES)
    : []
  const footerCandidates = [
    ...wrappedWarning.map((line) => style('error')(line)),
    chalk.dim(
      `Selected: ${ellipsize(
        sanitizeUntrustedText(formatPickerModelName(selected)),
        wrapWidth
      )}`
    ),
    chalk.dim(`Size: ${formatBytes(selected.size)}`),
    chalk.dim(`Modified: ${sanitizeUntrustedText(selected.modified_at)}`),
  ]
  const footerPayload = footerCandidates.slice(0, Math.max(footerBudget - 1, 0))
  const footer = footerPayload.length > 0 ? ['', ...footerPayload] : []
  const visibleCount = Math.max(contentRows - footer.length, 1)
  const start = clamp(
    safeSelectedIndex - Math.floor(visibleCount / 2),
    0,
    Math.max(models.length - visibleCount, 0)
  )
  const end = Math.min(start + visibleCount, models.length)
  const lines: string[] = [...header]

  for (let index = start; index < end; index += 1)
  {
    const model = models[index]!
    const prefix =
      index === safeSelectedIndex ? style('primary')('›') : chalk.dim(' ')
    const label = ellipsize(
      sanitizeUntrustedText(formatPickerModelName(model)),
      Math.max(wrapWidth - 2, 1)
    )
    const name = index === safeSelectedIndex ? style('user')(label) : label
    lines.push(`${prefix} ${name}`)
  }

  lines.push(...footer)
  if (models.length > visibleCount && lines.length < viewportHeight)
  {
    lines.push(chalk.dim(`Showing ${start + 1}-${end} of ${models.length}`))
  }

  return lines.slice(0, viewportHeight)
}
