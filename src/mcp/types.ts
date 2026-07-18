// src/mcp/types.ts
// status and approval contracts for MCP

import type {
  McpConfigIssue,
  McpConfigResolution,
  McpServerConfig,
} from '../config/mcp.js'
import type { McpLaunchDescriptor } from './trust.js'

export type McpServerState =
  | 'blocked'
  | 'configured'
  | 'failed'
  | 'needs_trust'
  | 'ready'
  | 'rejected'
  | 'stopped'

export interface McpServerStatus
{
  alias: string
  state: McpServerState
  configuredTools: string[]
  availableTools: string[]
  executable?: string
  launchCwd: string
  passEnv: string[]
  message?: string
  stderr?: string
}

export interface McpStatus
{
  configIssues: McpConfigIssue[]
  servers: McpServerStatus[]
}

export interface McpLaunchApprovalRequest extends McpLaunchDescriptor
{
  fingerprint: string
}

// pre-launch status shared by config-only views and the live manager
export function configuredServerStatus(
  server: McpServerConfig
): McpServerStatus
{
  return {
    alias: server.alias,
    state: 'configured',
    configuredTools: [...server.enabledTools],
    availableTools: [],
    launchCwd: server.launchCwd,
    passEnv: [...server.passEnv],
  }
}

// observational status straight from config — no SDK load, no process spawn
export function configuredMcpStatus(config: McpConfigResolution): McpStatus
{
  return {
    configIssues: config.issues.map((issue) => ({ ...issue })),
    servers: config.servers.map(configuredServerStatus),
  }
}
