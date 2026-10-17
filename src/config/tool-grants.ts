// src/config/tool-grants.ts
// persisted per-workspace allow-always grants for built-in tools

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getBuiltInToolRegistration } from '../tools/catalog.js'
import { coralHomePath } from '../utils/coral-home.js'
import { isPlainObject } from '../utils/guards.js'
import { readJsonObjectFile, writeJsonFile } from '../utils/json.js'

const GRANT_FILE_VERSION = 1
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/
const SIDECAR_NAME_PATTERN = /^([0-9a-f]{64})\.json$/

export interface ToolGrantDescriptor
{
  toolName: string
  // canonical realpath of the session cwd; grants never cross workspaces
  workspace: string
}

export interface ToolGrantRecord extends ToolGrantDescriptor
{
  fingerprint: string
  approvedAt: string
}

interface ToolGrantSidecar extends ToolGrantRecord
{
  version: number
}

function grantsDir(): string
{
  return coralHomePath('tool-grants.d')
}

// the hash names the file so workspace paths never need encoding
function sidecarPath(fingerprint: string): string
{
  return join(grantsDir(), `${fingerprint}.json`)
}

// only trusted built-ins may be persisted; dynamic MCP authority stays in
// user config and launch trust
function isGrantableTool(toolName: string): boolean
{
  return getBuiltInToolRegistration(toolName) !== undefined
}

export function fingerprintToolGrant(descriptor: ToolGrantDescriptor): string
{
  const payload = {
    version: GRANT_FILE_VERSION,
    toolName: descriptor.toolName,
    workspace: descriptor.workspace,
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

// a sidecar is trusted only when every stored field matches the query and the
// recomputed fingerprint; anything else reads as no grant
function isGrantSidecar(
  value: unknown,
  descriptor: ToolGrantDescriptor,
  fingerprint: string
): value is ToolGrantSidecar
{
  return (
    isPlainObject(value) &&
    value.version === GRANT_FILE_VERSION &&
    value.toolName === descriptor.toolName &&
    value.workspace === descriptor.workspace &&
    value.fingerprint === fingerprint &&
    FINGERPRINT_PATTERN.test(fingerprint) &&
    typeof value.approvedAt === 'string'
  )
}

export function isToolGrantTrusted(descriptor: ToolGrantDescriptor): boolean
{
  if (!isGrantableTool(descriptor.toolName)) return false
  const fingerprint = fingerprintToolGrant(descriptor)
  const value = readJsonObjectFile(sidecarPath(fingerprint))
  return isGrantSidecar(value, descriptor, fingerprint)
}

export function trustToolGrant(descriptor: ToolGrantDescriptor): void
{
  if (!isGrantableTool(descriptor.toolName))
  {
    throw new Error(
      `Tool ${descriptor.toolName} cannot be granted persistently`
    )
  }
  const fingerprint = fingerprintToolGrant(descriptor)
  const sidecar: ToolGrantSidecar = {
    version: GRANT_FILE_VERSION,
    toolName: descriptor.toolName,
    workspace: descriptor.workspace,
    fingerprint,
    approvedAt: new Date().toISOString(),
  }
  writeJsonFile(sidecarPath(fingerprint), sidecar)
}

// remove a grant and report whether one existed
export function revokeToolGrant(descriptor: ToolGrantDescriptor): boolean
{
  const path = sidecarPath(fingerprintToolGrant(descriptor))
  const existed = lstatSync(path, { throwIfNoEntry: false }) !== undefined
  rmSync(path, { force: true })
  return existed
}

export function listToolGrants(workspace: string): ToolGrantRecord[]
{
  let names: string[]
  try
  {
    names = readdirSync(grantsDir())
  }
  catch
  {
    return []
  }

  const records: ToolGrantRecord[] = []
  for (const name of names)
  {
    const match = SIDECAR_NAME_PATTERN.exec(name)
    if (!match) continue
    const value = readJsonObjectFile(join(grantsDir(), name))
    if (!isPlainObject(value) || typeof value.toolName !== 'string') continue
    const descriptor = { toolName: value.toolName, workspace }
    if (!isGrantableTool(descriptor.toolName)) continue
    const fingerprint = fingerprintToolGrant(descriptor)
    if (fingerprint !== match[1]) continue
    if (!isGrantSidecar(value, descriptor, fingerprint)) continue
    records.push({
      toolName: value.toolName,
      workspace,
      fingerprint,
      approvedAt: value.approvedAt,
    })
  }
  return records.sort((a, b) => a.toolName.localeCompare(b.toolName))
}

// grants bound to one canonical workspace so callers pass only tool names
export interface WorkspaceToolGrants
{
  readonly workspace: string
  isTrusted: (toolName: string) => boolean
  trust: (toolName: string) => void
  revoke: (toolName: string) => boolean
  list: () => ToolGrantRecord[]
}

// realpath the cwd once; a missing directory falls back to the resolved path
// so the fingerprint is still deterministic
function canonicalWorkspace(cwd: string): string
{
  try
  {
    return realpathSync(cwd)
  }
  catch
  {
    return resolve(cwd)
  }
}

export function workspaceToolGrants(cwd: string): WorkspaceToolGrants
{
  const workspace = canonicalWorkspace(cwd)
  return {
    workspace,
    isTrusted: (toolName) => isToolGrantTrusted({ toolName, workspace }),
    trust: (toolName) => trustToolGrant({ toolName, workspace }),
    revoke: (toolName) => revokeToolGrant({ toolName, workspace }),
    list: () => listToolGrants(workspace),
  }
}
