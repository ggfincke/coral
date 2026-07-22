// src/mcp/types.ts
// status and approval contracts for MCP

import type {
  McpConfigIssue,
  McpConfigResolution,
  McpServerConfig,
} from '../config/mcp.js'
import type { McpLaunchDescriptor } from './trust.js'

export type McpMode = 'off' | 'ask' | 'yolo'
export type ActiveMcpMode = Exclude<McpMode, 'off'>

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
  yoloTools: string[]
  availableTools: string[]
  executable?: string
  launchCwd: string
  passEnv: string[]
  message?: string
  stderr?: string
}

export interface McpStatus
{
  mode: McpMode
  configIssues: McpConfigIssue[]
  servers: McpServerStatus[]
}

export interface McpLaunchApprovalRequest extends McpLaunchDescriptor
{
  fingerprint: string
}

// pre-launch status shared by config-only views and the live manager
export function configuredServerStatus(
  server: McpServerConfig,
  mode: McpMode
): McpServerStatus
{
  const unavailable =
    mode === 'off'
      ? 'MCP is disabled for this Agent'
      : mode === 'yolo' && server.yoloTools.length === 0
        ? 'no tools are enabled for yolo mode'
        : undefined
  return {
    alias: server.alias,
    state: unavailable ? 'blocked' : 'configured',
    configuredTools: [...server.enabledTools],
    yoloTools: [...server.yoloTools],
    availableTools: [],
    launchCwd: server.launchCwd,
    passEnv: [...server.passEnv],
    message: unavailable,
  }
}

// observational status straight from config — no SDK load, no process spawn
export function configuredMcpStatus(
  config: McpConfigResolution,
  mode: McpMode
): McpStatus
{
  return {
    mode,
    configIssues: config.issues.map((issue) => ({ ...issue })),
    servers: config.servers.map((server) =>
      configuredServerStatus(server, mode)
    ),
  }
}
