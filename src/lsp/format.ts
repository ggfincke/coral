// src/lsp/format.ts
// compact TypeScript LSP response formatting

import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatProjectPath,
  isPathInsideProject,
} from '../shared/project-tree.js'
import { isPlainObject } from '../utils/guards.js'
import { truncateToLineBoundary } from '../utils/truncate-output.js'

const MAX_LOCATIONS = 100
const MAX_DIAGNOSTICS = 100
const MAX_HOVER_CHARS = 8_000

interface Position
{
  line: number
  character: number
}

interface Location
{
  uri: string
  start: Position
}

export interface LspDiagnostic
{
  range?: {
    start?: Position
  }
  severity?: number
  code?: string | number
  source?: string
  message?: string
}

function position(value: unknown): Position | null
{
  if (!isPlainObject(value)) return null
  if (typeof value.line !== 'number') return null
  if (typeof value.character !== 'number') return null
  return { line: value.line, character: value.character }
}

function location(value: unknown): Location | null
{
  if (!isPlainObject(value)) return null

  const uri =
    typeof value.uri === 'string'
      ? value.uri
      : typeof value.targetUri === 'string'
        ? value.targetUri
        : null
  if (!uri) return null

  const range = isPlainObject(value.targetSelectionRange)
    ? value.targetSelectionRange
    : isPlainObject(value.targetRange)
      ? value.targetRange
      : isPlainObject(value.range)
        ? value.range
        : null
  const start = position(range?.start)
  if (!start) return null
  return { uri, start }
}

function locationPath(cwd: string, uri: string): string
{
  try
  {
    const path = fileURLToPath(uri)
    if (isPathInsideProject(cwd, path)) return formatProjectPath(cwd, path)
    return `[external]/${basename(path)}`
  }
  catch
  {
    return '[external]'
  }
}

function formatPositionedPath(cwd: string, item: Location): string
{
  const path = locationPath(cwd, item.uri)
  return `${path}:${item.start.line + 1}:${item.start.character + 1}`
}

export function formatLocationResult(
  result: unknown,
  cwd: string,
  label: 'definition' | 'references'
): string
{
  const values =
    result === null || result === undefined
      ? []
      : Array.isArray(result)
        ? result
        : [result]
  const locations = values.map(location).filter((item) => item !== null)

  if (locations.length === 0)
  {
    return label === 'definition'
      ? 'No definition found for that position.'
      : 'No references found for that position.'
  }

  const shown = locations.slice(0, MAX_LOCATIONS)
  const lines = shown.map((item) => formatPositionedPath(cwd, item))
  if (locations.length > shown.length)
  {
    lines.push(`... ${locations.length - shown.length} more omitted`)
  }
  return lines.join('\n')
}

function hoverPart(value: unknown): string
{
  if (typeof value === 'string') return value
  if (!isPlainObject(value) || typeof value.value !== 'string') return ''

  if (typeof value.language === 'string')
  {
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``
  }
  return value.value
}

export function formatHoverResult(result: unknown): string
{
  if (!isPlainObject(result)) return 'No hover information found.'
  const contents = result.contents
  const parts = Array.isArray(contents)
    ? contents.map(hoverPart).filter(Boolean)
    : [hoverPart(contents)].filter(Boolean)
  const text = parts.join('\n\n').trim()
  if (!text) return 'No hover information found.'

  const truncated = truncateToLineBoundary(text, MAX_HOVER_CHARS)
  if (!truncated.truncated) return text
  return `${truncated.head}\n\n[hover truncated: ${truncated.omitted} chars omitted]`
}

function diagnosticSeverity(value: number | undefined): string
{
  if (value === 1) return 'ERROR'
  if (value === 2) return 'WARN'
  if (value === 3) return 'INFO'
  if (value === 4) return 'HINT'
  return 'DIAGNOSTIC'
}

function diagnosticSuffix(item: LspDiagnostic): string
{
  const details = [item.source, item.code].filter(
    (value) => typeof value === 'string' || typeof value === 'number'
  )
  return details.length > 0 ? ` [${details.join(' ')}]` : ''
}

export function formatDiagnostics(
  diagnostics: LspDiagnostic[],
  cwd: string,
  path: string
): string
{
  if (diagnostics.length === 0) return 'No diagnostics reported for this file.'

  const displayPath = isPathInsideProject(cwd, path)
    ? formatProjectPath(cwd, path)
    : `[external]/${basename(path)}`
  const shown = diagnostics.slice(0, MAX_DIAGNOSTICS)
  const lines = shown.map((item) =>
  {
    const range = isPlainObject(item.range) ? item.range : undefined
    const start = isPlainObject(range?.start) ? range.start : undefined
    const line = typeof start?.line === 'number' ? start.line + 1 : 1
    const character =
      typeof start?.character === 'number' ? start.character + 1 : 1
    const message = (
      typeof item.message === 'string' ? item.message : 'Unknown diagnostic'
    )
      .replace(/\s+/g, ' ')
      .trim()
    return (
      `${diagnosticSeverity(item.severity)} ${displayPath}:${line}:${character}` +
      `${diagnosticSuffix(item)} ${message}`
    )
  })

  if (diagnostics.length > shown.length)
  {
    lines.push(`... ${diagnostics.length - shown.length} more omitted`)
  }
  return lines.join('\n')
}
