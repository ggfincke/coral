// src/skills/discover.ts
// discover skill packages, format the prompt catalog, and load confined files

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ellipsize } from '../utils/ellipsize.js'
import { parseSkillFrontmatter } from './parse.js'
import { SkillIndex, type SkillRecord, type SkillSource } from './types.js'

export { EMPTY_SKILL_INDEX, SkillIndex } from './types.js'
export type { SkillRecord, SkillSource } from './types.js'

export const USER_INSTRUCTIONS_READ_LIMIT_BYTES = 8_192
const CATALOG_DESCRIPTION_MAX_CHARS = 400
const SKILL_FILE_READ_LIMIT_BYTES = 1_048_576

export const PERSONAL_SKILLS_HINT =
  'Personal skills live in AGENTS_HOME/skills (default ~/.agents/skills). Install with ggfincke-skills: python3 scripts/sync-skills.py --target agents  or  make sync'

export interface DiscoverSkillsOptions
{
  cwd: string
  agentsHome: string
}

export type SkillLoadResult =
  { ok: true; content: string; path: string } | { ok: false; error: string }

interface SkillRoot
{
  source: SkillSource
  dir: string
}

function skillRoots(options: DiscoverSkillsOptions): SkillRoot[]
{
  return [
    { source: 'user', dir: join(options.agentsHome, 'skills') },
    { source: 'project-agents', dir: join(options.cwd, '.agents', 'skills') },
    { source: 'project-coral', dir: join(options.cwd, '.coral', 'skills') },
  ]
}

function isDirectoryEntry(
  parent: string,
  name: string,
  direntIsDir: boolean,
  direntIsSymlink: boolean
): boolean
{
  if (direntIsDir) return true
  if (!direntIsSymlink) return false
  try
  {
    return statSync(join(parent, name)).isDirectory()
  }
  catch
  {
    return false
  }
}

interface SkillFileRead
{
  content: string
  path: string
}

function readDescriptorBounded(
  descriptor: number,
  maxBytes: number
): { content: string; truncated: boolean }
{
  const buffer = Buffer.alloc(maxBytes + 1)
  let offset = 0
  while (offset < buffer.length)
  {
    const read = readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      offset
    )
    if (read === 0) break
    offset += read
  }
  const truncated = offset > maxBytes
  const used = truncated ? maxBytes : offset
  return {
    content: buffer.subarray(0, used).toString('utf-8'),
    truncated,
  }
}

function resolvePackageRoot(packageDir: string): string | null
{
  try
  {
    const real = realpathSync(packageDir)
    return statSync(real).isDirectory() ? real : null
  }
  catch
  {
    return null
  }
}

function readConfinedRegularFile(
  root: string,
  segments: readonly string[]
): SkillFileRead | null
{
  const candidate = resolve(root, ...segments)
  let target: string
  try
  {
    target = realpathSync(candidate)
  }
  catch
  {
    return null
  }
  if (!isPathInsideRoot(root, target)) return null

  let descriptor: number | undefined
  try
  {
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stats = fstatSync(descriptor)
    const current = statSync(target)
    if (
      !stats.isFile() ||
      stats.dev !== current.dev ||
      stats.ino !== current.ino ||
      stats.size > SKILL_FILE_READ_LIMIT_BYTES
    )
    {
      return null
    }
    const bounded = readDescriptorBounded(
      descriptor,
      SKILL_FILE_READ_LIMIT_BYTES
    )
    if (bounded.truncated) return null
    return {
      path: target,
      content: bounded.content,
    }
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

function recordFromPackage(
  packageDir: string,
  source: SkillSource
): SkillRecord | null
{
  const root = resolvePackageRoot(packageDir)
  if (!root) return null
  const loaded = readConfinedRegularFile(root, ['SKILL.md'])
  if (!loaded) return null
  const parsed = parseSkillFrontmatter(loaded.content)
  if (!parsed) return null
  return {
    name: parsed.name,
    description: parsed.description,
    source,
    root,
  }
}

// later roots overwrite on frontmatter name collision; invalid packages are skipped
export function discoverSkills(options: DiscoverSkillsOptions): SkillIndex
{
  const byName = new Map<string, SkillRecord>()
  for (const root of skillRoots(options))
  {
    let entries: { name: string; isDir: boolean; isSymlink: boolean }[]
    try
    {
      entries = readdirSync(root.dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDir: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      }))
    }
    catch
    {
      continue
    }

    for (const entry of entries)
    {
      if (entry.name.startsWith('.')) continue
      if (
        !isDirectoryEntry(root.dir, entry.name, entry.isDir, entry.isSymlink)
      )
      {
        continue
      }
      const record = recordFromPackage(join(root.dir, entry.name), root.source)
      if (record) byName.set(record.name, record)
    }
  }

  return new SkillIndex(
    [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  )
}

export interface FormatSkillCatalogOptions
{
  maxChars?: number
  maxBytes?: number
  descriptionMaxChars?: number
}

function truncateUtf8(text: string, maxBytes: number): string
{
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text
  let result = ''
  let used = 0
  for (const char of text)
  {
    const bytes = Buffer.byteLength(char, 'utf-8')
    if (used + bytes > maxBytes) break
    result += char
    used += bytes
  }
  return result
}

export function formatSkillCatalog(
  index: SkillIndex,
  options: FormatSkillCatalogOptions = {}
): string
{
  const descriptionMaxChars = Math.max(
    0,
    Math.floor(options.descriptionMaxChars ?? CATALOG_DESCRIPTION_MAX_CHARS)
  )
  const formatRecord = (record: SkillRecord): string =>
  {
    const description = ellipsize(
      record.description.replace(/\s+/g, ' ').trim(),
      descriptionMaxChars
    )
    return `- **${record.name}**: ${description}`
  }

  if (options.maxChars === undefined && options.maxBytes === undefined)
  {
    return index.records.map(formatRecord).join('\n')
  }
  const maxChars =
    options.maxChars === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxChars))
  const maxBytes =
    options.maxBytes === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxBytes))
  const fits = (value: string): boolean =>
    value.length <= maxChars && Buffer.byteLength(value, 'utf-8') <= maxBytes

  const kept: string[] = []
  for (const record of index.records)
  {
    const line = formatRecord(record)
    const next = [...kept, line]
    const omitted = index.size - next.length
    const marker = `- … ${omitted} more skills omitted; use /skills to list`
    const candidate = [...next, ...(omitted > 0 ? [marker] : [])].join('\n')
    if (!fits(candidate)) break
    kept.push(line)
  }

  if (kept.length === index.size) return kept.join('\n')
  const omitted = index.size - kept.length
  const marker = `- … ${omitted} more skills omitted; use /skills to list`
  const prefix = kept.length > 0 ? `${kept.join('\n')}\n` : ''
  const markerChars = Math.max(maxChars - prefix.length, 0)
  const markerBytes = Math.max(maxBytes - Buffer.byteLength(prefix, 'utf-8'), 0)
  return `${prefix}${truncateUtf8(ellipsize(marker, markerChars), markerBytes)}`
}

export function loadUserInstructions(agentsHome: string): string
{
  const path = join(agentsHome, 'AGENTS.md')
  if (!existsSync(path)) return ''
  let descriptor: number | undefined
  try
  {
    const target = realpathSync(path)
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stats = fstatSync(descriptor)
    const current = statSync(target)
    if (
      !stats.isFile() ||
      stats.dev !== current.dev ||
      stats.ino !== current.ino
    )
    {
      return ''
    }
    const bounded = readDescriptorBounded(
      descriptor,
      USER_INSTRUCTIONS_READ_LIMIT_BYTES
    )
    const content = bounded.content
    if (!content.trim()) return ''
    return bounded.truncated ? `${content}\n… (truncated)` : content
  }
  catch
  {
    return ''
  }
  finally
  {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function relativeSkillSegments(file: string): string[] | null
{
  const trimmed = file.trim()
  if (!trimmed) return null
  if (isAbsolute(trimmed)) return null
  if (/^[a-zA-Z]:/.test(trimmed)) return null
  const normalized = trimmed.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return null
  const parts = normalized.split('/').filter((part) => part !== '.')
  if (parts.length === 0) return null
  if (parts.some((part) => part === '..' || part === '')) return null
  return parts
}

function isPathInsideRoot(root: string, target: string): boolean
{
  const rel = relative(root, target)
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  )
}

function isAllowedSkillFile(segments: readonly string[]): boolean
{
  return (
    (segments.length === 1 && segments[0] === 'SKILL.md') ||
    (segments.length > 1 && segments[0] === 'references')
  )
}

// load a file confined to the resolved package root; reject `..` and symlink escape
export function loadSkillFile(
  record: SkillRecord,
  file = 'SKILL.md'
): SkillLoadResult
{
  const segments = relativeSkillSegments(file)
  if (!segments)
  {
    return {
      ok: false,
      error: 'skill file must be a relative path inside the skill package',
    }
  }
  if (!isAllowedSkillFile(segments))
  {
    return {
      ok: false,
      error: 'skill file must be SKILL.md or a file under references/',
    }
  }

  let root: string
  try
  {
    root = realpathSync(record.root)
  }
  catch
  {
    return { ok: false, error: `skill package is unreadable: ${record.root}` }
  }

  const loaded = readConfinedRegularFile(root, segments)
  if (loaded) return { ok: true, ...loaded }
  return {
    ok: false,
    error: `skill file is missing, unsafe, non-regular, or exceeds ${SKILL_FILE_READ_LIMIT_BYTES} bytes: ${segments.join('/')}`,
  }
}
