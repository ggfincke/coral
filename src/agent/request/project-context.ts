// src/agent/request/project-context.ts
// project context loading for conversation starts

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createIgnoredEntrySet } from '../../shared/ignored-entries.js'
import {
  compareProjectTreeEntries,
  formatProjectTreeEntryName,
  shouldIncludeProjectTreeEntry,
} from '../../shared/project-tree.js'
import { CHARS_PER_TOKEN } from '../../utils/limits.js'

// cap the bytes read from any single context file
const MAX_CONTEXT_FILE_BYTES = 8_192

// cap injected context before num_ctx is known
const DEFAULT_TOTAL_CHARS = 16_384

// reserve about one eighth of the pinned context window for project context
const PROJECT_CONTEXT_FRACTION = 0.125
const MIN_TOTAL_CHARS = 4_096
const MAX_TOTAL_CHARS = 32_768

// standing project instructions in priority order; only the first present
// file loads, since manifests & READMEs are one read_file away
const INSTRUCTION_FILES: { name: string; label: string }[] = [
  { name: '.coral.md', label: 'Project Instructions (.coral.md)' },
  { name: 'AGENTS.md', label: 'Agent Instructions (AGENTS.md)' },
  { name: 'CLAUDE.md', label: 'Agent Instructions (CLAUDE.md)' },
]

// root manifests that identify the project type
const PROJECT_TYPES: { names: string[]; type: string }[] = [
  { names: ['package.json'], type: 'Node.js/JavaScript' },
  { names: ['pyproject.toml', 'requirements.txt'], type: 'Python' },
  { names: ['Cargo.toml'], type: 'Rust' },
  { names: ['go.mod'], type: 'Go' },
  { names: ['Gemfile'], type: 'Ruby' },
  { names: ['pom.xml', 'build.gradle'], type: 'Java/JVM' },
]

// directories to skip in the project tree
const IGNORED_DIRS = createIgnoredEntrySet()

// loaded project context
interface ContextFile
{
  readonly label: string
  readonly name: string
  readonly content: string
}

interface RootEntry
{
  name: string
  isDir: boolean
  isSymlink: boolean
}

/** Immutable filesystem observations reused throughout one prompt fit. */
export interface ProjectContextSnapshot
{
  readonly rootSummary: string
  readonly files: readonly ContextFile[]
}

export interface ProjectContextOptions
{
  maxTotalChars?: number
}

export function projectContextBudgetForWindow(contextWindow: number): number
{
  if (!Number.isFinite(contextWindow) || contextWindow <= 0)
  {
    return DEFAULT_TOTAL_CHARS
  }

  const chars = Math.floor(
    contextWindow * CHARS_PER_TOKEN * PROJECT_CONTEXT_FRACTION
  )
  return Math.min(Math.max(chars, MIN_TOTAL_CHARS), MAX_TOTAL_CHARS)
}

// read one context file within the byte limit
function readContextFile(path: string): string | null
{
  let descriptor: number | undefined
  try
  {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    if (!fstatSync(descriptor).isFile()) return null
    const buffer = Buffer.allocUnsafe(MAX_CONTEXT_FILE_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length)
    {
      const count = readSync(
        descriptor,
        buffer,
        bytes,
        buffer.length - bytes,
        bytes
      )
      if (count === 0) break
      bytes += count
    }
    if (bytes === 0) return null
    if (bytes > MAX_CONTEXT_FILE_BYTES)
    {
      // leave a partial trailing UTF-8 code point out of the retained prefix
      return (
        new StringDecoder('utf8').write(
          buffer.subarray(0, MAX_CONTEXT_FILE_BYTES)
        ) + '\n… (truncated)'
      )
    }
    return buffer.toString('utf8', 0, bytes)
  }
  catch
  {
    return null
  }
  finally
  {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function readDirectory(dir: string): RootEntry[] | null
{
  try
  {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDir: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink(),
    }))
  }
  catch
  {
    return null
  }
}

// root summaries include hidden entries
function formatRootSummary(cwd: string, root: RootEntry[] | null): string
{
  if (!root)
  {
    return `Project name: ${basename(cwd)}\nTop-level entries: unavailable`
  }
  const entries = root
    .filter((entry) => shouldIncludeProjectTreeEntry(entry.name, IGNORED_DIRS))
    .sort(compareProjectTreeEntries)
    .slice(0, 12)
    .map(formatProjectTreeEntryName)
  const suffix = entries.length === 12 ? ' (truncated)' : ''
  const summary = entries.length > 0 ? entries.join(', ') : '(empty)'
  const projectType = detectProjectType(root)
  const typeLine = projectType ? `\nProject type: ${projectType}` : ''
  return `Project name: ${basename(cwd)}${typeLine}\nTop-level entries${suffix}: ${summary}`
}

// detect the project type from root manifests
function detectProjectType(root: readonly RootEntry[]): string | null
{
  const names = new Set(
    root.filter((entry) => !entry.isDir).map((entry) => entry.name)
  )
  return (
    PROJECT_TYPES.find((candidate) =>
      candidate.names.some((name) => names.has(name))
    )?.type ?? null
  )
}

// capture filesystem state once; rendering different budgets never rereads it
export function captureProjectContext(
  cwd: string,
  options: ProjectContextOptions = {}
): ProjectContextSnapshot
{
  const root = readDirectory(cwd)
  const loaded: ContextFile[] = []
  if (Math.floor(options.maxTotalChars ?? DEFAULT_TOTAL_CHARS) > 0)
  {
    for (const { name, label } of INSTRUCTION_FILES)
    {
      const content = readContextFile(join(cwd, name))
      if (!content) continue
      loaded.push(Object.freeze({ label, name, content }))
      break
    }
  }
  return Object.freeze({
    rootSummary: formatRootSummary(cwd, root),
    files: Object.freeze(loaded),
  })
}

export function renderProjectContext(
  snapshot: ProjectContextSnapshot,
  options: ProjectContextOptions = {}
): string
{
  const maxTotalChars = Math.max(
    0,
    Math.floor(options.maxTotalChars ?? DEFAULT_TOTAL_CHARS)
  )
  if (maxTotalChars === 0) return ''

  const loaded = snapshot.files
  if (loaded.length === 0)
  {
    return ''
  }

  const sections: string[] = []
  const appendIfFits = (section: string): boolean =>
  {
    const separator = sections.length > 0 ? '\n\n' : ''
    if (
      sections.join('\n\n').length + separator.length + section.length >
      maxTotalChars
    )
    {
      return false
    }
    sections.push(section)
    return true
  }

  // charge formatting and truncation markers against the same cap
  for (const file of loaded)
  {
    const body = file.content.trim()
    const prefix = `### ${file.label}\n\n\`\`\`\n`
    const suffix = '\n```'
    const full = `${prefix}${body}${suffix}`
    if (appendIfFits(full)) continue

    const separator = sections.length > 0 ? '\n\n' : ''
    const marker = '\n… (truncated to fit budget)'
    const used = sections.join('\n\n').length
    const bodyBudget =
      maxTotalChars -
      used -
      separator.length -
      prefix.length -
      suffix.length -
      marker.length
    if (bodyBudget > 0)
    {
      sections.push(`${prefix}${body.slice(0, bodyBudget)}${marker}${suffix}`)
    }
    break
  }

  return sections.join('\n\n')
}

// gather available project context into one bounded block
export function gatherProjectContext(
  cwd: string,
  options: ProjectContextOptions = {}
): string
{
  if (Math.floor(options.maxTotalChars ?? DEFAULT_TOTAL_CHARS) <= 0) return ''
  return renderProjectContext(captureProjectContext(cwd, options), options)
}
