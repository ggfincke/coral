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
import {
  canonicalSkillName,
  compareSkillText,
  SkillIndex,
  type SkillCollision,
  type SkillRecord,
  type SkillSource,
} from './types.js'

export { EMPTY_SKILL_INDEX, SkillIndex } from './types.js'
export type { SkillCollision, SkillRecord, SkillSource } from './types.js'

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
  confinePackages: boolean
}

interface SkillFileRead
{
  content: string
  path: string
}

function isPathInsideRoot(root: string, target: string): boolean
{
  const rel = relative(root, target)
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  )
}

function resolveDirectory(path: string): string | null
{
  try
  {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : null
  }
  catch
  {
    return null
  }
}

// personal packages may point elsewhere; project roots and packages stay in the checkout
function skillRoots(options: DiscoverSkillsOptions): SkillRoot[]
{
  const roots: SkillRoot[] = []
  const user = resolveDirectory(join(options.agentsHome, 'skills'))
  if (user)
  {
    roots.push({ source: 'user', dir: user, confinePackages: false })
  }

  const checkout = resolveDirectory(options.cwd)
  if (!checkout) return roots
  for (const candidate of [
    {
      source: 'project-coral' as const,
      path: join(options.cwd, '.coral', 'skills'),
    },
    {
      source: 'project-agents' as const,
      path: join(options.cwd, '.agents', 'skills'),
    },
  ])
  {
    const dir = resolveDirectory(candidate.path)
    if (dir && isPathInsideRoot(checkout, dir))
    {
      roots.push({ source: candidate.source, dir, confinePackages: true })
    }
  }
  return roots
}

// size the buffer from fstat so small files never allocate the full limit;
// growth past that size after fstat reads as truncation
function readDescriptorBounded(
  descriptor: number,
  maxBytes: number,
  sizeHint: number
): { content: string; truncated: boolean }
{
  const limit = Math.min(maxBytes, sizeHint)
  const buffer = Buffer.alloc(limit + 1)
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
  const truncated = offset > limit
  const used = truncated ? limit : offset
  return {
    content: buffer.subarray(0, used).toString('utf-8'),
    truncated,
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
    descriptor = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
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
      SKILL_FILE_READ_LIMIT_BYTES,
      stats.size
    )
    if (bounded.truncated) return null
    return { path: target, content: bounded.content }
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
  root: SkillRoot
): SkillRecord | null
{
  const packageRoot = resolveDirectory(packageDir)
  if (!packageRoot) return null
  if (root.confinePackages && !isPathInsideRoot(root.dir, packageRoot))
  {
    return null
  }
  const loaded = readConfinedRegularFile(packageRoot, ['SKILL.md'])
  if (!loaded) return null
  const parsed = parseSkillFrontmatter(loaded.content)
  if (!parsed) return null
  return {
    name: parsed.name,
    description: parsed.description,
    source: root.source,
    root: packageRoot,
  }
}

// roots arrive in precedence order; lexical package order is the stable tie-breaker
export function discoverSkills(options: DiscoverSkillsOptions): SkillIndex
{
  const winners = new Map<string, SkillRecord>()
  const rejected = new Map<string, SkillRecord[]>()

  for (const root of skillRoots(options))
  {
    let entries: string[]
    try
    {
      entries = readdirSync(root.dir, { withFileTypes: true })
        .filter(
          (entry) =>
            !entry.name.startsWith('.') &&
            (entry.isDirectory() || entry.isSymbolicLink())
        )
        .map((entry) => entry.name)
        .sort(compareSkillText)
    }
    catch
    {
      continue
    }

    for (const entry of entries)
    {
      const record = recordFromPackage(join(root.dir, entry), root)
      if (!record) continue
      const key = canonicalSkillName(record.name)
      if (!winners.has(key)) winners.set(key, record)
      else
      {
        const records = rejected.get(key) ?? []
        records.push(record)
        rejected.set(key, records)
      }
    }
  }

  const records = [...winners.values()].sort((left, right) =>
    compareSkillText(
      canonicalSkillName(left.name),
      canonicalSkillName(right.name)
    )
  )
  const collisions: SkillCollision[] = [...rejected.entries()]
    .map(([canonicalName, records]) => ({
      canonicalName,
      winner: winners.get(canonicalName)!,
      rejected: records,
    }))
    .sort((left, right) =>
      compareSkillText(left.canonicalName, right.canonicalName)
    )
  return new SkillIndex(records, collisions)
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
  for (const character of text)
  {
    const bytes = Buffer.byteLength(character, 'utf-8')
    if (used + bytes > maxBytes) break
    result += character
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
    // repository-supplied packages are tagged so they never read as the
    // user's own instructions
    const origin = record.source === 'user' ? '' : ' (project)'
    return `- **${record.name}**${origin}: ${description}`
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
    const marker = `- ... ${omitted} more skills omitted; call the skill tool with any name to list all`
    const candidate = [...next, ...(omitted > 0 ? [marker] : [])].join('\n')
    if (!fits(candidate)) break
    kept.push(line)
  }

  if (kept.length === index.size) return kept.join('\n')
  const omitted = index.size - kept.length
  const marker = `- ... ${omitted} more skills omitted; call the skill tool with any name to list all`
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
    descriptor = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
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
      USER_INSTRUCTIONS_READ_LIMIT_BYTES,
      stats.size
    )
    if (!bounded.content.trim()) return ''
    return bounded.truncated
      ? `${bounded.content}\n... (truncated)`
      : bounded.content
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
  if (!trimmed || isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) return null
  const normalized = trimmed.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return null
  const parts = normalized.split('/').filter((part) => part !== '.')
  if (parts.length === 0) return null
  if (parts.some((part) => part === '..' || part === '')) return null
  return parts
}

function isAllowedSkillFile(segments: readonly string[]): boolean
{
  return (
    (segments.length === 1 && segments[0] === 'SKILL.md') ||
    (segments.length > 1 && segments[0] === 'references')
  )
}

// load only the package body or references; scripts are never readable here
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

  const root = resolveDirectory(record.root)
  if (!root || root !== record.root)
  {
    return { ok: false, error: `skill package is unreadable: ${record.root}` }
  }
  let loaded: SkillFileRead | null
  if (segments[0] === 'references')
  {
    const referencesRoot = resolveDirectory(join(root, 'references'))
    if (!referencesRoot || referencesRoot !== join(root, 'references'))
    {
      return {
        ok: false,
        error: 'skill references directory is missing or unsafe',
      }
    }
    loaded = readConfinedRegularFile(referencesRoot, segments.slice(1))
  }
  else
  {
    loaded = readConfinedRegularFile(root, segments)
  }
  if (loaded) return { ok: true, ...loaded }
  return {
    ok: false,
    error: `skill file is missing, unsafe, non-regular, or exceeds ${SKILL_FILE_READ_LIMIT_BYTES} bytes: ${segments.join('/')}`,
  }
}
