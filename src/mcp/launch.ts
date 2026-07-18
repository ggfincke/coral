// src/mcp/launch.ts
// resolve MCP launch inputs & sanitize launch diagnostics

import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig } from '../config/mcp.js'
import { ellipsize } from '../utils/ellipsize.js'
import { toErrorMessage } from '../utils/errors.js'
import { redactDiagnostic } from './output.js'

const MAX_STATUS_MESSAGE_CHARS = 2_000

export interface McpLaunchEnvironment
{
  environment: Record<string, string>
  secretValues: string[]
}

export interface McpMissingLaunchEnvironment
{
  missingEnvironmentNames: string[]
}

function windowsExecutableNames(command: string): string[]
{
  if (process.platform !== 'win32' || extname(command)) return [command]
  return [command + '.EXE', command + '.COM']
}

export async function resolveMcpExecutable(
  command: string,
  pathValue: string
): Promise<string>
{
  if (
    process.platform === 'win32' &&
    extname(command) &&
    !['.exe', '.com'].includes(extname(command).toLowerCase())
  )
  {
    throw new Error(
      'Windows MCP commands must use a native .exe or .com executable'
    )
  }

  const candidates = isAbsolute(command)
    ? [command]
    : pathValue
        .split(delimiter)
        .filter(Boolean)
        .flatMap((directory) =>
          windowsExecutableNames(command).map((name) => join(directory, name))
        )

  for (const candidate of candidates)
  {
    try
    {
      await access(
        candidate,
        process.platform === 'win32' ? constants.F_OK : constants.X_OK
      )
      const resolved = await realpath(candidate)
      if (
        process.platform === 'win32' &&
        !['.exe', '.com'].includes(extname(resolved).toLowerCase())
      )
      {
        throw new Error(
          'Windows MCP commands must resolve to a native .exe or .com executable'
        )
      }
      return resolved
    }
    catch
    {
      continue
    }
  }

  throw new Error(`executable not found on the MCP launch PATH: ${command}`)
}

function forwardedValues(
  server: McpServerConfig,
  environment: Record<string, string>
): string[]
{
  return server.passEnv
    .map((name) => environment[name])
    .filter((value): value is string => value !== undefined && value !== '')
}

export function resolveMcpLaunchEnvironment(
  server: McpServerConfig
): McpLaunchEnvironment | McpMissingLaunchEnvironment
{
  const environment = getDefaultEnvironment()
  const missing = server.passEnv.filter(
    (name) => process.env[name] === undefined
  )
  if (missing.length > 0)
  {
    return { missingEnvironmentNames: missing }
  }

  for (const name of server.passEnv)
  {
    environment[name] = process.env[name]!
  }
  return {
    environment,
    secretValues: forwardedValues(server, environment),
  }
}

export function formatMcpStatusMessage(
  error: unknown,
  secretValues: readonly string[] = []
): string
{
  return ellipsize(
    redactDiagnostic(toErrorMessage(error), secretValues),
    MAX_STATUS_MESSAGE_CHARS
  )
}
