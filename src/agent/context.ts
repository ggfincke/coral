// src/agent/context.ts
// auto-load project context at conversation start

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createIgnoredEntrySet } from '../shared/ignored-entries.js'
import {
  compareProjectTreeEntries,
  formatProjectTreeEntryName,
  shouldIncludeProjectTreeEntry,
} from '../shared/project-tree.js'

// max bytes to read from any single context file
const MAX_CONTEXT_FILE_BYTES = 8_192

// max total chars across all injected context (rough token budget: chars/4 ≈ tokens)
const MAX_TOTAL_CHARS = 16_384

// project files to look for, in priority order
// higher priority files are loaded first & guaranteed space
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

// directories to skip when building tree
const IGNORED_DIRS = createIgnoredEntrySet()

// a loaded context file w/ its content
interface ContextFile
{
  label: string
  name: string
  content: string
}

// read a file up to MAX_CONTEXT_FILE_BYTES, returning null if missing/unreadable
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

// build a compact directory tree (2 levels deep) for project overview
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

    // limit entries per level to prevent huge trees
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

// detect project type from available context files
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

// gather all available project context & format as a single block
export function gatherProjectContext(cwd: string): string
{
  const loaded: ContextFile[] = []
  let totalChars = 0

  // load context files in priority order
  for (const { name, label } of CONTEXT_FILES)
  {
    const content = readContextFile(join(cwd, name))
    if (!content) continue

    // check budget before adding
    if (totalChars + content.length > MAX_TOTAL_CHARS)
    {
      // still try to fit w/ truncation if file is large
      const remaining = MAX_TOTAL_CHARS - totalChars
      if (remaining > 256)
      {
        loaded.push({
          label,
          name,
          content:
            content.slice(0, remaining) + '\n… (truncated to fit budget)',
        })
        totalChars = MAX_TOTAL_CHARS
      }
      break
    }

    loaded.push({ label, name, content })
    totalChars += content.length
  }

  if (loaded.length === 0)
  {
    return ''
  }

  const sections: string[] = []

  // project type detection
  const projectType = detectProjectType(loaded)
  if (projectType)
  {
    sections.push(`Detected project type: ${projectType}`)
  }

  // directory tree
  const tree = buildDirectoryTree(cwd)
  if (tree)
  {
    sections.push(`Directory structure:\n${tree}`)
  }

  // file contents
  for (const file of loaded)
  {
    sections.push(`### ${file.label}\n\n\`\`\`\n${file.content.trim()}\n\`\`\``)
  }

  return sections.join('\n\n')
}
