// src/mcp/trust.ts
// persisted MCP launch fingerprints

import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
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

interface McpTrustSidecar extends McpTrustEntry
{
  version: number
  alias: string
}

function legacyTrustPath(): string
{
  return coralHomePath('mcp-trust.json')
}

function trustSidecarPath(alias: string): string
{
  return join(coralHomePath('mcp-trust.d'), `${alias}.json`)
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

function loadLegacyTrustFile(): McpTrustFile
{
  const value = readJsonObjectFile(legacyTrustPath())
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

function hasTrustSidecar(path: string): boolean
{
  try
  {
    // inspect the entry itself so dangling symlinks still shadow legacy trust
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined
  }
  catch
  {
    // an inaccessible sidecar still shadows legacy trust and fails closed
    return true
  }
}

function isTrustSidecar(
  value: unknown,
  alias: string
): value is McpTrustSidecar
{
  return (
    isPlainObject(value) &&
    value.version === TRUST_FILE_VERSION &&
    value.alias === alias &&
    isTrustEntry(value)
  )
}

function loadTrustEntry(alias: string): McpTrustEntry | undefined
{
  if (!SERVER_ALIAS_PATTERN.test(alias)) return undefined

  const sidecarPath = trustSidecarPath(alias)
  if (hasTrustSidecar(sidecarPath))
  {
    const value = readJsonObjectFile(sidecarPath)
    return isTrustSidecar(value, alias) ? value : undefined
  }
  return loadLegacyTrustFile().servers[alias]
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
  const entry = loadTrustEntry(descriptor.alias)
  return entry?.fingerprint === fingerprintMcpLaunch(descriptor)
}

export function trustMcpLaunch(descriptor: McpLaunchDescriptor): void
{
  if (!SERVER_ALIAS_PATTERN.test(descriptor.alias))
  {
    throw new Error('Invalid MCP server alias')
  }
  const sidecar: McpTrustSidecar = {
    version: TRUST_FILE_VERSION,
    alias: descriptor.alias,
    fingerprint: fingerprintMcpLaunch(descriptor),
    approvedAt: new Date().toISOString(),
  }
  writeJsonFile(trustSidecarPath(descriptor.alias), sidecar)
}
