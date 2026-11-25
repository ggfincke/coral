// src/mcp/trust.ts
// persisted MCP launch fingerprints

import { createHash } from 'node:crypto'
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
  yoloTools: string[]
}

interface McpTrustEntry
{
  fingerprint: string
  approvedAt: string
}

interface McpTrustSidecar extends McpTrustEntry
{
  version: number
  alias: string
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

  // a missing, unreadable, or invalid sidecar leaves the launch untrusted
  const value = readJsonObjectFile(trustSidecarPath(alias))
  return isTrustSidecar(value, alias) ? value : undefined
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
    ...(descriptor.yoloTools.length > 0
      ? { yoloTools: [...descriptor.yoloTools].sort() }
      : {}),
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
