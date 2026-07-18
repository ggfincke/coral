// src/config/mcp.ts
// user-owned MCP server config parsing

import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { isPlainObject } from '../utils/guards.js'
import { loadUserConfig } from './project-config.js'

const SERVER_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_SERVERS = 4
const MAX_TOOLS = 12
const MAX_ARGS = 64
const MAX_COMMAND_CHARS = 1_024
const MAX_ARG_CHARS = 4_096
const MAX_TOOL_NAME_CHARS = 128
const MAX_ENV_NAMES = 32
const MIN_TIMEOUT_MS = 1_000
const MAX_STARTUP_TIMEOUT_MS = 60_000
const MAX_TOOL_TIMEOUT_MS = 600_000

export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 10_000
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000

export interface McpServerConfig
{
  alias: string
  command: string
  args: string[]
  enabledTools: string[]
  passEnv: string[]
  startupTimeoutMs: number
  toolTimeoutMs: number
  launchCwd: string
}

export interface McpConfigIssue
{
  server?: string
  message: string
}

export interface McpConfigResolution
{
  servers: McpServerConfig[]
  issues: McpConfigIssue[]
}

interface ParseResult<T>
{
  value?: T
  error?: string
}

function parseStringArray(
  value: unknown,
  options: {
    field: string
    required: boolean
    maxItems: number
    maxChars: number
    pattern?: RegExp
    allowDuplicates?: boolean
  }
): ParseResult<string[]>
{
  if (value === undefined && !options.required) return { value: [] }
  if (!Array.isArray(value) || (options.required && value.length === 0))
  {
    return { error: `${options.field} must be a nonempty string array` }
  }
  if (value.length > options.maxItems)
  {
    return {
      error: `${options.field} exceeds the ${options.maxItems}-item limit`,
    }
  }

  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value)
  {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > options.maxChars ||
      item.includes('\0') ||
      (options.pattern && !options.pattern.test(item))
    )
    {
      return { error: `${options.field} contains an invalid value` }
    }
    if (!options.allowDuplicates && seen.has(item))
    {
      return { error: `${options.field} contains duplicate values` }
    }
    seen.add(item)
    result.push(item)
  }

  return { value: result }
}

function parseTimeout(
  value: unknown,
  field: string,
  fallback: number,
  maximum: number
): ParseResult<number>
{
  if (value === undefined) return { value: fallback }
  if (
    !Number.isInteger(value) ||
    Number(value) < MIN_TIMEOUT_MS ||
    Number(value) > maximum
  )
  {
    return {
      error: `${field} must be an integer from ${MIN_TIMEOUT_MS} to ${maximum}`,
    }
  }
  return { value: Number(value) }
}

function parseServer(
  alias: string,
  value: unknown
): ParseResult<McpServerConfig>
{
  if (!SERVER_ALIAS_PATTERN.test(alias))
  {
    return { error: 'server alias is invalid' }
  }
  if (!isPlainObject(value)) return { error: 'server config must be an object' }

  const command = typeof value.command === 'string' ? value.command.trim() : ''
  if (
    !command ||
    command.length > MAX_COMMAND_CHARS ||
    command.includes('\0')
  )
  {
    return { error: 'command must be a nonempty string' }
  }
  if (
    (command.includes('/') || command.includes('\\')) &&
    !isAbsolute(command)
  )
  {
    return { error: 'path-like commands must be absolute' }
  }

  const args = parseStringArray(value.args, {
    field: 'args',
    required: false,
    maxItems: MAX_ARGS,
    maxChars: MAX_ARG_CHARS,
    allowDuplicates: true,
  })
  if (args.error) return { error: args.error }

  const enabledTools = parseStringArray(value.enabledTools, {
    field: 'enabledTools',
    required: true,
    maxItems: MAX_TOOLS,
    maxChars: MAX_TOOL_NAME_CHARS,
    pattern: MCP_TOOL_NAME_PATTERN,
  })
  if (enabledTools.error) return { error: enabledTools.error }

  const passEnv = parseStringArray(value.passEnv, {
    field: 'passEnv',
    required: false,
    maxItems: MAX_ENV_NAMES,
    maxChars: 128,
    pattern: ENV_NAME_PATTERN,
  })
  if (passEnv.error) return { error: passEnv.error }

  const startupTimeout = parseTimeout(
    value.startupTimeoutMs,
    'startupTimeoutMs',
    DEFAULT_MCP_STARTUP_TIMEOUT_MS,
    MAX_STARTUP_TIMEOUT_MS
  )
  if (startupTimeout.error) return { error: startupTimeout.error }

  const toolTimeout = parseTimeout(
    value.toolTimeoutMs,
    'toolTimeoutMs',
    DEFAULT_MCP_TOOL_TIMEOUT_MS,
    MAX_TOOL_TIMEOUT_MS
  )
  if (toolTimeout.error) return { error: toolTimeout.error }

  return {
    value: {
      alias,
      command,
      args: args.value!,
      enabledTools: enabledTools.value!,
      passEnv: passEnv.value!,
      startupTimeoutMs: startupTimeout.value!,
      toolTimeoutMs: toolTimeout.value!,
      launchCwd: homedir(),
    },
  }
}

export function parseMcpConfig(raw: unknown): McpConfigResolution
{
  if (raw === undefined) return { servers: [], issues: [] }
  if (!isPlainObject(raw) || !isPlainObject(raw.servers))
  {
    return {
      servers: [],
      issues: [{ message: 'mcp.servers must be an object' }],
    }
  }

  const entries = Object.entries(raw.servers)
  if (entries.length > MAX_SERVERS)
  {
    return {
      servers: [],
      issues: [
        { message: `mcp.servers exceeds the ${MAX_SERVERS}-server limit` },
      ],
    }
  }

  const servers: McpServerConfig[] = []
  const issues: McpConfigIssue[] = []
  for (const [alias, value] of entries)
  {
    const parsed = parseServer(alias, value)
    if (parsed.error)
    {
      issues.push({ server: alias, message: parsed.error })
    }
    else
    {
      servers.push(parsed.value!)
    }
  }

  const toolCount = servers.reduce(
    (total, server) => total + server.enabledTools.length,
    0
  )
  if (toolCount > MAX_TOOLS)
  {
    return {
      servers: [],
      issues: [
        ...issues,
        { message: `enabled MCP tools exceed the ${MAX_TOOLS}-tool limit` },
      ],
    }
  }

  return { servers, issues }
}

export function resolveMcpConfig(): McpConfigResolution
{
  return parseMcpConfig(loadUserConfig().mcp)
}
