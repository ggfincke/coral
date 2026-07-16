// src/mcp/trust.ts
// persist approved MCP launch fingerprints

import { createHash } from 'node:crypto'
import { coralHomePath } from '../utils/coral-home.js'
import { isPlainObject } from '../utils/guards.js'
import { readJsonObjectFile, writeJsonFile } from '../utils/json.js'

const TRUST_FILE_VERSION = 1
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/
const SERVER_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

export interface McpLaunchDescriptor
{
  alias: string
  command: string
  executable: string
  args: string[]
  launchCwd: string
  passEnv: string[]
  enabledTools: string[]
}

interface McpTrustEntry
{
  fingerprint: string
  approvedAt: string
}

interface McpTrustFile
{
  version: number
  servers: Record<string, McpTrustEntry>
}

function trustPath(): string
{
  return coralHomePath('mcp-trust.json')
}

function isTrustEntry(value: unknown): value is McpTrustEntry
{
  return (
    isPlainObject(value) &&
    typeof value.fingerprint === 'string' &&
    FINGERPRINT_PATTERN.test(value.fingerprint) &&
    typeof value.approvedAt === 'string'
  )
}

function loadTrustFile(): McpTrustFile
{
  const value = readJsonObjectFile(trustPath())
  if (
    !isPlainObject(value) ||
    value.version !== TRUST_FILE_VERSION ||
    !isPlainObject(value.servers)
  )
  {
    return {
      version: TRUST_FILE_VERSION,
      servers: Object.create(null) as Record<string, McpTrustEntry>,
    }
  }

  const servers: Record<string, McpTrustEntry> = Object.create(null)
  for (const [alias, entry] of Object.entries(value.servers))
  {
    if (SERVER_ALIAS_PATTERN.test(alias) && isTrustEntry(entry))
    {
      servers[alias] = entry
    }
  }
  return { version: TRUST_FILE_VERSION, servers }
}

export function fingerprintMcpLaunch(descriptor: McpLaunchDescriptor): string
{
  const payload = {
    version: TRUST_FILE_VERSION,
    alias: descriptor.alias,
    command: descriptor.command,
    executable: descriptor.executable,
    args: descriptor.args,
    launchCwd: descriptor.launchCwd,
    passEnv: [...descriptor.passEnv].sort(),
    enabledTools: [...descriptor.enabledTools].sort(),
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function isMcpLaunchTrusted(descriptor: McpLaunchDescriptor): boolean
{
  const entry = loadTrustFile().servers[descriptor.alias]
  return entry?.fingerprint === fingerprintMcpLaunch(descriptor)
}

export function trustMcpLaunch(descriptor: McpLaunchDescriptor): void
{
  if (!SERVER_ALIAS_PATTERN.test(descriptor.alias))
  {
    throw new Error('Invalid MCP server alias')
  }
  const file = loadTrustFile()
  file.servers[descriptor.alias] = {
    fingerprint: fingerprintMcpLaunch(descriptor),
    approvedAt: new Date().toISOString(),
  }
  writeJsonFile(trustPath(), file)
}
