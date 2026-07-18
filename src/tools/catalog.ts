// src/tools/catalog.ts
// immutable active tools and trusted built-in security registration

import type { OllamaTool } from '../types/inference.js'
import { ellipsize } from '../utils/ellipsize.js'
import {
  sanitizeUntrustedText,
  stringifyForDisplay,
} from '../utils/untrusted-text.js'
import { normalizeToolName } from '../utils/tool-name.js'
import {
  estimateOllamaToolTokens,
  toolToOllamaFormat,
  type Tool,
  type ToolCallPresentation,
} from './tool.js'

export type DefaultToolPolicy =
  'always_allow' | 'require_approval' | 'always_deny'

export interface WorkspacePathRule
{
  argument: 'path'
  defaultPath?: '.'
}

export interface BuiltInToolRegistration
{
  name: string
  defaultPolicy: DefaultToolPolicy
  workspacePath?: WorkspacePathRule
}

export interface ToolCapabilityProfile
{
  name: string
  source: 'trusted' | 'dynamic'
  builtIn: boolean
  workspacePath: boolean
  subagentSafe: boolean
  parallelSafe: boolean
}

export const UNKNOWN_TOOL_DEFAULT_POLICY: DefaultToolPolicy = 'require_approval'
const MAX_PRESENTATION_LABEL_CHARS = 256
const MAX_PRESENTATION_SUMMARY_CHARS = 8_000
const PRESENTATION_SUMMARY_TRUNCATION = '… [tool argument summary truncated]'

// host-owned security metadata; dynamic tools never extend this registration
const REGISTRATIONS: BuiltInToolRegistration[] = [
  {
    name: 'read_file',
    defaultPolicy: 'always_allow',
    workspacePath: { argument: 'path' },
  },
  {
    name: 'write_file',
    defaultPolicy: 'require_approval',
    workspacePath: { argument: 'path', defaultPath: '.' },
  },
  {
    name: 'edit_file',
    defaultPolicy: 'require_approval',
    workspacePath: { argument: 'path', defaultPath: '.' },
  },
  {
    name: 'grep',
    defaultPolicy: 'always_allow',
    workspacePath: { argument: 'path', defaultPath: '.' },
  },
  {
    name: 'glob',
    defaultPolicy: 'always_allow',
    workspacePath: { argument: 'path', defaultPath: '.' },
  },
  {
    name: 'list_files',
    defaultPolicy: 'always_allow',
    workspacePath: { argument: 'path', defaultPath: '.' },
  },
  { name: 'search_code', defaultPolicy: 'always_allow' },
  {
    name: 'code_intel',
    defaultPolicy: 'always_allow',
    workspacePath: { argument: 'path' },
  },
  { name: 'bash', defaultPolicy: 'require_approval' },
  { name: 'git_status', defaultPolicy: 'always_allow' },
  { name: 'git_diff', defaultPolicy: 'always_allow' },
  { name: 'git_log', defaultPolicy: 'always_allow' },
  { name: 'git_add', defaultPolicy: 'require_approval' },
  { name: 'git_commit', defaultPolicy: 'require_approval' },
  { name: 'git_switch', defaultPolicy: 'require_approval' },
  { name: 'git_push', defaultPolicy: 'require_approval' },
  { name: 'task', defaultPolicy: 'always_allow' },
  { name: 'todo_write', defaultPolicy: 'always_allow' },
]

export const builtInToolRegistrations: readonly BuiltInToolRegistration[] =
  Object.freeze(
    REGISTRATIONS.map((registration) =>
      Object.freeze({
        ...registration,
        workspacePath: registration.workspacePath
          ? Object.freeze({ ...registration.workspacePath })
          : undefined,
      })
    )
  )

const registrationByName = new Map(
  builtInToolRegistrations.map((registration) => [
    registration.name,
    registration,
  ])
)
const registrationByNormalizedName = new Map(
  builtInToolRegistrations.map((registration) => [
    normalizeToolName(registration.name),
    registration,
  ])
)

if (
  registrationByName.size !== builtInToolRegistrations.length ||
  registrationByNormalizedName.size !== builtInToolRegistrations.length
)
{
  throw new Error('Duplicate trusted built-in tool registration')
}

export function getBuiltInToolRegistration(
  name: string
): BuiltInToolRegistration | undefined
{
  return registrationByName.get(name)
}

// fail closed when the executable built-in view and security metadata drift
export function assertBuiltInToolsRegistered(tools: readonly Tool[]): void
{
  const names = tools.map((tool) => tool.name)
  const nameSet = new Set(names)
  const duplicateNames = names.filter(
    (name, index) => names.indexOf(name) !== index
  )
  const missingTools = builtInToolRegistrations
    .map((registration) => registration.name)
    .filter((name) => !nameSet.has(name))
  const unregisteredTools = [...nameSet].filter(
    (name) => !registrationByName.has(name)
  )

  if (
    duplicateNames.length === 0 &&
    missingTools.length === 0 &&
    unregisteredTools.length === 0
  )
  {
    return
  }

  const details = [
    duplicateNames.length > 0
      ? `duplicates: ${[...new Set(duplicateNames)].join(', ')}`
      : '',
    missingTools.length > 0 ? `missing: ${missingTools.join(', ')}` : '',
    unregisteredTools.length > 0
      ? `unregistered: ${unregisteredTools.join(', ')}`
      : '',
  ].filter(Boolean)

  throw new Error(`Built-in tool registration drift (${details.join('; ')})`)
}

function assertUniqueActiveNames(tools: readonly Tool[]): void
{
  const seen = new Set<string>()
  const seenNormalized = new Map<string, string>()
  for (const tool of tools)
  {
    if (seen.has(tool.name))
    {
      throw new Error(`Duplicate active tool name: ${tool.name}`)
    }
    seen.add(tool.name)

    const normalized = normalizeToolName(tool.name)
    if (seenNormalized.has(normalized))
    {
      const existing = seenNormalized.get(normalized)!
      throw new Error(
        `Active tool names collide after normalization: ${existing}, ${tool.name}`
      )
    }
    seenNormalized.set(normalized, tool.name)
  }
}

function cloneFrozenJson<T>(value: T): T
{
  if (Array.isArray(value))
  {
    return Object.freeze(value.map((item) => cloneFrozenJson(item))) as T
  }
  if (typeof value === 'object' && value !== null)
  {
    const clone = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneFrozenJson(item)])
    )
    return Object.freeze(clone) as T
  }
  return value
}

// snapshot declarative metadata so later source mutation cannot split views
function snapshotTool(tool: Tool): Tool
{
  const snapshot: Tool = {
    name: tool.name,
    description: tool.description,
    parameters: cloneFrozenJson(tool.parameters),
    execute: tool.execute,
  }
  if (tool.subagentSafe !== undefined)
  {
    snapshot.subagentSafe = tool.subagentSafe
  }
  if (tool.parallelSafe !== undefined)
  {
    snapshot.parallelSafe = tool.parallelSafe
  }
  if (tool.display) snapshot.display = Object.freeze({ ...tool.display })
  if (tool.validateArgs) snapshot.validateArgs = tool.validateArgs
  return Object.freeze(snapshot)
}

function sanitizePresentationText(text: string, maxChars: number): string
{
  return ellipsize(
    sanitizeUntrustedText(text).replace(/\s+/g, ' ').trim(),
    maxChars
  )
}

function fallbackSummary(args: Record<string, unknown>): string
{
  return ellipsize(sanitizeUntrustedText(stringifyForDisplay(args)).trim(), 60)
}

function sanitizePresentationSummary(text: string): string
{
  return ellipsize(
    sanitizeUntrustedText(text).trim(),
    MAX_PRESENTATION_SUMMARY_CHARS,
    PRESENTATION_SUMMARY_TRUNCATION
  )
}

export class ToolCatalog
{
  readonly tools: readonly Tool[]
  readonly names: readonly string[]
  readonly ollamaTools: readonly OllamaTool[]
  readonly definitionTokens: number
  readonly trustedDefinitionTokens: number
  readonly subagentTools: readonly Tool[]
  private readonly toolsByName: ReadonlyMap<string, Tool>
  private readonly profilesByName: ReadonlyMap<string, ToolCapabilityProfile>

  constructor(options: {
    trustedTools: readonly Tool[]
    dynamicTools?: readonly Tool[]
  })
  {
    const sourceDynamicTools = options.dynamicTools ?? []
    const impersonatedBuiltIn = sourceDynamicTools.find((tool) =>
      registrationByNormalizedName.has(normalizeToolName(tool.name))
    )
    if (impersonatedBuiltIn)
    {
      throw new Error(
        `Dynamic tool cannot claim built-in name: ${impersonatedBuiltIn.name}`
      )
    }

    const trustedTools = options.trustedTools.map(snapshotTool)
    const dynamicTools = sourceDynamicTools.map(snapshotTool)

    const tools = [...trustedTools, ...dynamicTools]
    assertUniqueActiveNames(tools)

    const trustedNames = new Set(trustedTools.map((tool) => tool.name))
    const profiles = tools.map((tool): ToolCapabilityProfile =>
    {
      const trusted = trustedNames.has(tool.name)
      const registration = trusted
        ? registrationByName.get(tool.name)
        : undefined
      return Object.freeze({
        name: tool.name,
        source: trusted ? 'trusted' : 'dynamic',
        builtIn: registration !== undefined,
        workspacePath: registration?.workspacePath !== undefined,
        // capability flags are authority only on Coral-hosted trusted tools
        subagentSafe: trusted && tool.subagentSafe === true,
        parallelSafe: trusted && tool.parallelSafe === true,
      })
    })

    const ollamaTools = tools.map((tool) =>
      cloneFrozenJson(toolToOllamaFormat(tool))
    )
    const trustedOllamaTools = trustedTools.map((tool) =>
      cloneFrozenJson(toolToOllamaFormat(tool))
    )
    this.tools = Object.freeze(tools)
    this.names = Object.freeze(tools.map((tool) => tool.name))
    this.ollamaTools = Object.freeze(ollamaTools)
    this.definitionTokens = estimateOllamaToolTokens(ollamaTools)
    this.trustedDefinitionTokens = estimateOllamaToolTokens(trustedOllamaTools)
    this.subagentTools = Object.freeze(
      trustedTools.filter((tool) => tool.subagentSafe === true)
    )
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]))
    this.profilesByName = new Map(
      profiles.map((profile) => [profile.name, profile])
    )
  }

  has(name: string): boolean
  {
    return this.toolsByName.has(name)
  }

  get(name: string): Tool | undefined
  {
    return this.toolsByName.get(name)
  }

  getProfile(name: string): ToolCapabilityProfile | undefined
  {
    return this.profilesByName.get(name)
  }

  presentationFor(
    name: string,
    args: Record<string, unknown> = {}
  ): ToolCallPresentation | undefined
  {
    const profile = this.getProfile(name)
    const tool = this.get(name)
    if (!profile || !tool) return undefined

    let summary = fallbackSummary(args)
    let customSummary = false
    try
    {
      const summarizeArgs = cloneFrozenJson(args)
      const value = tool.display?.summarize?.(summarizeArgs)
      if (typeof value === 'string')
      {
        summary = value
        customSummary = true
      }
    }
    catch
    {
      // keep the fail-safe serialized summary when custom display code fails
    }

    const displayLabel = sanitizePresentationText(
      tool.display?.label ?? '',
      MAX_PRESENTATION_LABEL_CHARS
    )
    const nameLabel = sanitizePresentationText(
      name,
      MAX_PRESENTATION_LABEL_CHARS
    )

    return Object.freeze({
      label: displayLabel || nameLabel || 'tool',
      summary: customSummary
        ? sanitizePresentationSummary(summary)
        : fallbackSummary(args),
      mcp: profile.source === 'dynamic',
    })
  }
}
