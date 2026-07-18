// src/agent/request/project-context.ts
// project context loading for conversation starts

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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

// project files to load in priority order
const CONTEXT_FILES: { name: string; label: string }[] = [
  { name: '.coral.md', label: 'Project Instructions (.coral.md)' },
  { name: 'AGENTS.md', label: 'Agent Instructions (AGENTS.md)' },
  { name: 'README.md', label: 'README' },
  { name: 'CONTRIBUTING.md', label: 'Contributing Guide' },
  { name: 'package.json', label: 'package.json' },
  { name: 'pyproject.toml', label: 'pyproject.toml' },
  { name: 'Cargo.toml', label: 'Cargo.toml' },
  { name: 'go.mod', label: 'go.mod' },
  { name: 'Gemfile', label: 'Gemfile' },
  { name: 'requirements.txt', label: 'requirements.txt' },
  { name: 'pom.xml', label: 'pom.xml' },
  { name: 'build.gradle', label: 'build.gradle' },
  { name: 'Makefile', label: 'Makefile' },
  { name: 'Dockerfile', label: 'Dockerfile' },
  { name: 'docker-compose.yml', label: 'docker-compose.yml' },
  { name: 'docker-compose.yaml', label: 'docker-compose.yaml' },
  { name: '.env.example', label: '.env.example' },
]

// directories to skip in the project tree
const IGNORED_DIRS = createIgnoredEntrySet()

// loaded project context
interface ContextFile
{
  label: string
  name: string
  content: string
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
  try
  {
    const content = readFileSync(path, 'utf-8')
    if (!content) return null

    if (content.length > MAX_CONTEXT_FILE_BYTES)
    {
      return content.slice(0, MAX_CONTEXT_FILE_BYTES) + '\n… (truncated)'
    }
    return content
  }
  catch
  {
    return null
  }
}

// build a compact two-level project tree
function buildDirectoryTree(cwd: string, maxDepth = 2): string
{
  const lines: string[] = []

  function walk(dir: string, prefix: string, depth: number): void
  {
    if (depth > maxDepth) return

    let entries: { name: string; isDir: boolean }[]
    try
    {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) =>
          shouldIncludeProjectTreeEntry(e.name, IGNORED_DIRS, {
            includeHidden: false,
          })
        )
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) =>
          compareProjectTreeEntries(a, b, { directoriesFirst: true })
        )
    }
    catch
    {
      return
    }

    // cap entries at each level to keep the tree compact
    const maxEntries = 25
    const truncated = entries.length > maxEntries
    const visible = entries.slice(0, maxEntries)

    for (const entry of visible)
    {
      lines.push(`${prefix}${formatProjectTreeEntryName(entry)}`)

      if (entry.isDir && depth < maxDepth)
      {
        walk(join(dir, entry.name), prefix + '  ', depth + 1)
      }
    }

    if (truncated)
    {
      lines.push(`${prefix}… (${entries.length - maxEntries} more entries)`)
    }
  }

  walk(cwd, '  ', 1)
  return lines.join('\n')
}

// detect the project type from available context files
function detectProjectType(files: ContextFile[]): string | null
{
  const names = new Set(files.map((f) => f.name))

  if (names.has('package.json')) return 'Node.js/JavaScript'
  if (names.has('pyproject.toml') || names.has('requirements.txt'))
    return 'Python'
  if (names.has('Cargo.toml')) return 'Rust'
  if (names.has('go.mod')) return 'Go'
  if (names.has('Gemfile')) return 'Ruby'
  if (names.has('pom.xml') || names.has('build.gradle')) return 'Java/JVM'
  return null
}

// gather available project context into one bounded block
export function gatherProjectContext(
  cwd: string,
  options: ProjectContextOptions = {}
): string
{
  const loaded: ContextFile[] = []
  const maxTotalChars = Math.max(
    0,
    Math.floor(options.maxTotalChars ?? DEFAULT_TOTAL_CHARS)
  )
  if (maxTotalChars === 0) return ''

  // read candidates in priority order while honoring the total rendered budget
  for (const { name, label } of CONTEXT_FILES)
  {
    const content = readContextFile(join(cwd, name))
    if (!content) continue
    loaded.push({ label, name, content })
  }

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

  // append project type context
  const projectType = detectProjectType(loaded)
  if (projectType)
  {
    appendIfFits(`Detected project type: ${projectType}`)
  }

  // append the directory tree
  const tree = buildDirectoryTree(cwd)
  if (tree)
  {
    appendIfFits(`Directory structure:\n${tree}`)
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
