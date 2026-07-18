// src/mcp/manager.ts
// trusted stdio MCP client management

import { createRequire } from 'node:module'
import { StringDecoder } from 'node:string_decoder'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  ErrorCode,
  McpError,
  type Tool as McpSdkTool,
} from '@modelcontextprotocol/sdk/types.js'
import type { McpConfigResolution, McpServerConfig } from '../config/mcp.js'
import { getToolPolicy, type ToolPermissions } from '../config/permissions.js'
import type { JsonSchema } from '../types/inference.js'
import {
  estimateToolDefinitionTokens,
  type Tool,
  type ToolResult,
} from '../tools/tool.js'
import { raceAbort } from '../utils/abort.js'
import { trimLeadingLowSurrogate } from '../utils/ellipsize.js'
import { normalizeToolName } from '../utils/tool-name.js'
import {
  formatMcpStatusMessage,
  resolveMcpExecutable,
  resolveMcpLaunchEnvironment,
} from './launch.js'
import { normalizedSecrets, redactDiagnostic } from './output.js'
import {
  fingerprintMcpLaunch,
  isMcpLaunchTrusted,
  trustMcpLaunch,
  type McpLaunchDescriptor,
} from './trust.js'
import {
  configuredServerStatus,
  type McpLaunchApprovalRequest,
  type McpServerStatus,
  type McpStatus,
} from './types.js'
import { CoralStdioClientTransport } from './stdio-transport.js'
import {
  createMcpTool,
  permissiveSdkValidator,
  type McpResultBridge,
} from './tool-adapter.js'

const require = createRequire(import.meta.url)
const { version: coralVersion } = require('../../package.json') as {
  version: string
}

const MAX_DISCOVERY_PAGES = 16
const MAX_DISCOVERED_TOOLS = 512
const MAX_SCHEMA_CHARS = 25_000
const MAX_TOTAL_SCHEMA_CHARS = 100_000
const MAX_STDERR_CHARS = 4_000
const MAX_CONCURRENT_STARTUPS = 2

interface McpStderrBuffer
{
  decoder: StringDecoder
  raw: string
}

export interface McpInitializeOptions
{
  signal?: AbortSignal
  onLaunchApproval?: (request: McpLaunchApprovalRequest) => Promise<boolean>
}

interface McpManagerOptions
{
  // pin one config-derived snapshot per session
  config: McpConfigResolution
  permissions: ToolPermissions
  baseTools: readonly Tool[]
  maxDynamicToolTokens: number
}

interface McpSession
{
  client: Client
  status: McpServerStatus
  active: boolean
  secretValues: string[]
}

interface ConnectedServer
{
  client: Client
  transport: CoralStdioClientTransport
  tools: McpSdkTool[]
}

interface LaunchCandidate
{
  server: McpServerConfig
  status: McpServerStatus
  executable: string
  environment: Record<string, string>
  allowedTools: string[]
  secretValues: string[]
}

interface StartupResult
{
  candidate: LaunchCandidate
  connected?: ConnectedServer
  error?: unknown
}

const stderrBuffers = new WeakMap<McpServerStatus, McpStderrBuffer>()

function cloneStatus(status: McpServerStatus): McpServerStatus
{
  return {
    ...status,
    configuredTools: [...status.configuredTools],
    availableTools: [...status.availableTools],
    passEnv: [...status.passEnv],
  }
}

function canonicalToolName(alias: string, toolName: string): string
{
  return `mcp__${alias}__${toolName}`
}

function isAbortError(error: unknown): boolean
{
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message === 'Aborted')
  )
}

function appendStderr(
  status: McpServerStatus,
  chunk: unknown,
  secretValues: readonly string[]
): void
{
  let buffer = stderrBuffers.get(status)
  if (!buffer)
  {
    buffer = { decoder: new StringDecoder('utf8'), raw: '' }
    stderrBuffers.set(status, buffer)
  }

  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  const text = buffer.decoder.write(bytes)
  const longestSecret = normalizedSecrets(secretValues).reduce(
    (longest, value) => Math.max(longest, value.length),
    0
  )
  const retention = MAX_STDERR_CHARS + Math.max(longestSecret - 1, 0)
  buffer.raw = trimLeadingLowSurrogate(`${buffer.raw}${text}`.slice(-retention))
  status.stderr = trimLeadingLowSurrogate(
    redactDiagnostic(buffer.raw, secretValues).slice(-MAX_STDERR_CHARS)
  ).trim()
}

function schemaSize(schema: JsonSchema): number
{
  return JSON.stringify(schema).length
}

// * Own one fixed set of local MCP clients for an interactive Agent
export class McpManager
{
  private readonly config: McpConfigResolution
  private readonly permissions: ToolPermissions
  private readonly baseTools: readonly Tool[]
  private readonly maxDynamicToolTokens: number
  private readonly statuses: McpServerStatus[]
  private sessions: McpSession[] = []
  private tools: Tool[] = []
  private initializePromise?: Promise<Tool[]>
  private callQueue: Promise<void> = Promise.resolve()
  private readonly lifecycleAbort = new AbortController()
  private readonly pendingClients = new Set<Client>()
  private disposePromise?: Promise<void>
  private closing = false

  constructor(options: McpManagerOptions)
  {
    this.config = options.config
    this.permissions = options.permissions
    this.baseTools = options.baseTools
    this.maxDynamicToolTokens = options.maxDynamicToolTokens
    this.statuses = this.config.servers.map(configuredServerStatus)
  }

  getStatus(): McpStatus
  {
    return {
      configIssues: this.config.issues.map((issue) => ({ ...issue })),
      servers: this.statuses.map(cloneStatus),
    }
  }

  initialize(options: McpInitializeOptions = {}): Promise<Tool[]>
  {
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.lifecycleAbort.signal])
      : this.lifecycleAbort.signal
    this.initializePromise ??= this.initializeServers({ ...options, signal })
    return this.initializePromise
  }

  private async initializeServers(
    options: McpInitializeOptions
  ): Promise<Tool[]>
  {
    const preflight = await this.preflightServers(options)
    if (preflight.aborted || options.signal?.aborted)
    {
      await this.rollbackInitialization(preflight.candidates)
      return []
    }

    const results = await this.connectAuthorizedServers(
      preflight.candidates,
      options.signal
    )
    if (options.signal?.aborted)
    {
      await this.rollbackInitialization(preflight.candidates, results)
      return []
    }

    // install in config order so collisions, budgets, and model-tool order stay deterministic
    const occupiedNormalizedNames = new Set(
      this.baseTools.map((tool) => normalizeToolName(tool.name))
    )
    const schemaBudget = { chars: 0 }
    let aborted = false
    for (const result of results)
    {
      const { candidate, connected, error } = result
      if (error || !connected)
      {
        if (isAbortError(error) || options.signal?.aborted)
        {
          candidate.status.state = 'stopped'
          candidate.status.message = 'startup interrupted'
          aborted = true
          break
        }
        candidate.status.state = 'failed'
        candidate.status.message = formatMcpStatusMessage(
          error,
          candidate.secretValues
        )
        continue
      }

      try
      {
        await this.installConnectedServer(
          candidate,
          connected,
          occupiedNormalizedNames,
          schemaBudget
        )
      }
      catch (installError)
      {
        await connected.client.close().catch(() => undefined)
        if (isAbortError(installError) || options.signal?.aborted)
        {
          candidate.status.state = 'stopped'
          candidate.status.message = 'startup interrupted'
          aborted = true
          break
        }
        candidate.status.state = 'failed'
        candidate.status.message = formatMcpStatusMessage(
          installError,
          candidate.secretValues
        )
      }
    }

    if (aborted || options.signal?.aborted)
    {
      await this.rollbackInitialization(preflight.candidates, results)
      return []
    }

    return [...this.tools]
  }

  private async preflightServers(options: McpInitializeOptions): Promise<{
    candidates: LaunchCandidate[]
    aborted: boolean
  }>
  {
    const candidates: LaunchCandidate[] = []
    for (const [index, server] of this.config.servers.entries())
    {
      if (options.signal?.aborted) return { candidates, aborted: true }
      const status = this.statuses[index]!
      const allowedTools = server.enabledTools.filter(
        (name) =>
          getToolPolicy(
            this.permissions,
            canonicalToolName(server.alias, name)
          ) !== 'always_deny'
      )

      if (allowedTools.length === 0)
      {
        status.state = 'blocked'
        status.message = 'all configured tools are denied by permission policy'
        continue
      }

      let secretValues: string[] = []
      try
      {
        const launch = resolveMcpLaunchEnvironment(server)
        if ('missingEnvironmentNames' in launch)
        {
          status.state = 'failed'
          status.message = `missing required environment variable(s): ${launch.missingEnvironmentNames.join(', ')}`
          continue
        }
        const { environment } = launch
        secretValues = launch.secretValues
        const executable = await resolveMcpExecutable(
          server.command,
          environment.PATH ?? ''
        )
        status.executable = executable
        const descriptor: McpLaunchDescriptor = {
          alias: server.alias,
          command: server.command,
          executable,
          args: server.args,
          launchCwd: server.launchCwd,
          passEnv: server.passEnv,
          enabledTools: server.enabledTools,
        }

        if (!isMcpLaunchTrusted(descriptor))
        {
          if (!options.onLaunchApproval)
          {
            status.state = 'needs_trust'
            status.message = 'launch approval required'
            continue
          }
          // do not open an approval prompt after an abort
          if (options.signal?.aborted)
          {
            throw new DOMException('Aborted', 'AbortError')
          }

          const approved = await raceAbort(
            options.onLaunchApproval({
              ...descriptor,
              fingerprint: fingerprintMcpLaunch(descriptor),
            }),
            options.signal
          )
          if (!approved)
          {
            status.state = 'rejected'
            status.message = 'launch rejected'
            continue
          }
          trustMcpLaunch(descriptor)
        }

        candidates.push({
          server,
          status,
          executable,
          environment,
          allowedTools,
          secretValues,
        })
      }
      catch (error)
      {
        if (isAbortError(error) || options.signal?.aborted)
        {
          status.state = 'stopped'
          status.message = 'startup interrupted'
          return { candidates, aborted: true }
        }
        status.state = 'failed'
        status.message = formatMcpStatusMessage(error, secretValues)
      }
    }

    return { candidates, aborted: false }
  }

  private async connectAuthorizedServers(
    candidates: readonly LaunchCandidate[],
    signal?: AbortSignal
  ): Promise<StartupResult[]>
  {
    const results = new Array<StartupResult>(candidates.length)
    let next = 0
    const worker = async () =>
    {
      while (true)
      {
        const resultIndex = next++
        if (resultIndex >= candidates.length) return
        const candidate = candidates[resultIndex]!
        if (signal?.aborted)
        {
          results[resultIndex] = {
            candidate,
            error: new DOMException('Aborted', 'AbortError'),
          }
          continue
        }

        try
        {
          const connected = await this.connectServer(
            candidate.server,
            candidate.executable,
            candidate.environment,
            candidate.status,
            candidate.allowedTools,
            candidate.secretValues,
            signal
          )
          results[resultIndex] = { candidate, connected }
        }
        catch (error)
        {
          results[resultIndex] = { candidate, error }
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_STARTUPS, candidates.length) },
      worker
    )
    await Promise.all(workers)
    return results
  }

  private async installConnectedServer(
    candidate: LaunchCandidate,
    connected: ConnectedServer,
    occupiedNormalizedNames: Set<string>,
    schemaBudget: { chars: number }
  ): Promise<void>
  {
    const { server, status, allowedTools, secretValues } = candidate
    const discovered = new Map(connected.tools.map((tool) => [tool.name, tool]))
    const serverTools: Tool[] = []
    const session: McpSession = {
      client: connected.client,
      status,
      active: true,
      secretValues,
    }

    for (const rawName of allowedTools)
    {
      const definition = discovered.get(rawName)
      if (!definition)
      {
        status.message = `configured tool not exposed by server: ${rawName}`
        continue
      }
      if (definition.execution?.taskSupport === 'required')
      {
        status.message = `task-based MCP tools are unsupported: ${rawName}`
        continue
      }

      const name = canonicalToolName(server.alias, rawName)
      const normalized = normalizeToolName(name)
      if (occupiedNormalizedNames.has(normalized))
      {
        status.message = `tool name collides after normalization: ${name}`
        continue
      }

      const schema = definition.inputSchema as JsonSchema
      const outputSchema = definition.outputSchema as JsonSchema | undefined
      const chars =
        schemaSize(schema) + (outputSchema ? schemaSize(outputSchema) : 0)
      if (
        chars > MAX_SCHEMA_CHARS ||
        schemaBudget.chars + chars > MAX_TOTAL_SCHEMA_CHARS
      )
      {
        status.message = `tool schema exceeds the MCP schema budget: ${rawName}`
        continue
      }

      let tool: Tool
      try
      {
        tool = createMcpTool({
          name,
          displayLabel: `MCP · ${server.alias} · ${rawName}`,
          description: definition.description,
          inputSchema: schema,
          outputSchema,
          secretValues,
          invoke: (args, signal, bridgeResult) =>
            this.callTool(
              session,
              rawName,
              args,
              server.toolTimeoutMs,
              bridgeResult,
              signal
            ),
        })
      }
      catch (error)
      {
        status.message = `invalid schema for ${rawName}: ${formatMcpStatusMessage(error, secretValues)}`
        continue
      }

      const nextDynamicTools = [...this.tools, ...serverTools, tool]
      if (
        estimateToolDefinitionTokens(nextDynamicTools) >
        this.maxDynamicToolTokens
      )
      {
        status.message = `tool definition exceeds this session's context budget: ${rawName}`
        continue
      }

      occupiedNormalizedNames.add(normalized)
      schemaBudget.chars += chars
      serverTools.push(tool)
    }

    if (serverTools.length === 0)
    {
      await connected.client.close()
      status.state = 'failed'
      status.message ??= 'server exposed no usable allowlisted tools'
      return
    }
    if (connected.transport.pid === null)
    {
      await connected.client.close().catch(() => undefined)
      status.state = 'failed'
      status.message = 'MCP server exited during startup'
      return
    }

    this.sessions.push(session)
    this.tools.push(...serverTools)
    status.state = 'ready'
    status.availableTools = serverTools.map((tool) => tool.name)
  }

  private async rollbackInitialization(
    candidates: readonly LaunchCandidate[] = [],
    results: readonly StartupResult[] = []
  ): Promise<void>
  {
    const clients = new Set(this.sessions.map((session) => session.client))
    for (const result of results)
    {
      if (result.connected) clients.add(result.connected.client)
    }
    for (const candidate of candidates)
    {
      candidate.status.state = 'stopped'
      candidate.status.message = 'startup interrupted; restart Coral to retry'
    }
    for (const session of this.sessions)
    {
      session.active = false
    }
    await Promise.allSettled([...clients].map((client) => client.close()))
    this.sessions = []
    this.tools = []
  }

  // derive redaction from the caller's forwarded values for stderr and session output
  private async connectServer(
    server: McpServerConfig,
    executable: string,
    environment: Record<string, string>,
    status: McpServerStatus,
    enabledTools: readonly string[],
    secretValues: readonly string[],
    signal?: AbortSignal
  ): Promise<ConnectedServer>
  {
    const transport = new CoralStdioClientTransport({
      command: executable,
      args: server.args,
      env: environment,
      cwd: server.launchCwd,
    })
    transport.stderr?.on('data', (chunk) =>
      appendStderr(status, chunk, secretValues)
    )

    const client = new Client(
      { name: 'coral', version: coralVersion },
      {
        capabilities: {},
        enforceStrictCapabilities: true,
        jsonSchemaValidator: permissiveSdkValidator,
      }
    )
    client.onerror = (error) =>
    {
      if (this.closing) return
      status.message = formatMcpStatusMessage(error, secretValues)
    }
    client.onclose = () =>
    {
      if (this.closing || status.state === 'stopped') return
      status.state = 'failed'
      status.message ??= 'MCP server connection closed'
    }

    this.pendingClients.add(client)
    const deadline = AbortSignal.timeout(server.startupTimeoutMs)
    const startupSignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline
    const startup = async (): Promise<ConnectedServer> =>
    {
      await client.connect(transport, {
        signal: startupSignal,
        timeout: server.startupTimeoutMs,
        maxTotalTimeout: server.startupTimeoutMs,
      })
      const tools: McpSdkTool[] = []
      const names = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined

      for (let page = 0; page < MAX_DISCOVERY_PAGES; page++)
      {
        const result = await client.listTools(cursor ? { cursor } : undefined, {
          signal: startupSignal,
          timeout: server.startupTimeoutMs,
          maxTotalTimeout: server.startupTimeoutMs,
        })
        for (const tool of result.tools)
        {
          if (names.has(tool.name))
          {
            throw new Error(`server returned duplicate tool name: ${tool.name}`)
          }
          names.add(tool.name)
          tools.push(tool)
        }
        if (tools.length > MAX_DISCOVERED_TOOLS)
        {
          throw new Error('server exposed too many tools')
        }
        if (enabledTools.every((name) => names.has(name)))
        {
          return { client, transport, tools }
        }
        cursor = result.nextCursor
        if (!cursor) return { client, transport, tools }
        if (cursors.has(cursor))
        {
          throw new Error('server repeated a tool discovery cursor')
        }
        cursors.add(cursor)
      }

      throw new Error('tool discovery exceeded the page limit')
    }

    try
    {
      const connected = await raceAbort(startup(), startupSignal)
      this.pendingClients.delete(client)
      return connected
    }
    catch (error)
    {
      this.pendingClients.delete(client)
      await client.close().catch(() => undefined)
      if (deadline.aborted && !signal?.aborted)
      {
        throw new Error(`startup timed out after ${server.startupTimeoutMs} ms`)
      }
      throw error
    }
  }

  private enqueueCall<T>(call: () => Promise<T>): Promise<T>
  {
    const result = this.callQueue.then(call, call)
    this.callQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private callTool(
    session: McpSession,
    name: string,
    args: Record<string, unknown>,
    timeout: number,
    bridgeResult: McpResultBridge,
    signal?: AbortSignal
  ): Promise<ToolResult>
  {
    return this.enqueueCall(async () =>
    {
      if (!session.active || session.status.state !== 'ready')
      {
        return {
          output: '',
          error: 'MCP server is unavailable for this session',
        }
      }
      if (signal?.aborted)
      {
        await this.stopSession(session, 'tool call interrupted')
        throw new DOMException('Aborted', 'AbortError')
      }

      const statusBeforeCall = session.status.message
      try
      {
        const result = await session.client.callTool(
          { name, arguments: args },
          undefined,
          {
            signal,
            timeout,
            maxTotalTimeout: timeout,
          }
        )
        return bridgeResult(result)
      }
      catch (error)
      {
        if (
          signal?.aborted ||
          isAbortError(error) ||
          this.isRequestTimeout(error)
        )
        {
          const message =
            signal?.aborted || isAbortError(error)
              ? 'tool call interrupted; server stopped for this session'
              : 'tool call timed out; server stopped for this session'
          await this.stopSession(session, message)
          throw error
        }
        const callStatus =
          session.status.message !== statusBeforeCall
            ? session.status.message
            : undefined
        return {
          output: '',
          error: `MCP tool call failed: ${formatMcpStatusMessage(callStatus ?? error, session.secretValues)}`,
        }
      }
    })
  }

  private isRequestTimeout(error: unknown): boolean
  {
    return error instanceof McpError && error.code === ErrorCode.RequestTimeout
  }

  private async stopSession(
    session: McpSession,
    message: string
  ): Promise<void>
  {
    if (!session.active) return
    session.active = false
    session.status.state = 'stopped'
    session.status.message = message
    await session.client.close().catch(() => undefined)
  }

  async dispose(): Promise<void>
  {
    this.disposePromise ??= this.disposeInternal()
    return this.disposePromise
  }

  private async disposeInternal(): Promise<void>
  {
    this.closing = true
    this.lifecycleAbort.abort()
    for (const session of this.sessions)
    {
      session.active = false
      if (session.status.state === 'ready') session.status.state = 'stopped'
    }
    await Promise.allSettled(
      [...this.pendingClients].map((client) => client.close())
    )
    await this.initializePromise?.catch(() => undefined)
    await Promise.allSettled(
      this.sessions.map((session) => session.client.close())
    )
    this.sessions = []
    this.pendingClients.clear()
  }
}
