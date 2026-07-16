// src/mcp/manager.ts
// own trusted stdio MCP clients & expose allowlisted tools

import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { StringDecoder } from 'node:string_decoder'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool as McpSdkTool,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  JsonSchemaValidator,
  jsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation'
import { Ajv, type Options as AjvOptions } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import stripAnsi from 'strip-ansi'
import type { McpConfigResolution, McpServerConfig } from '../config/mcp.js'
import { getToolPolicy, type ToolPermissions } from '../config/permissions.js'
import type { JsonSchema } from '../types/inference.js'
import type { Tool, ToolArgumentValidation, ToolResult } from '../tools/tool.js'
import { capToolOutput } from '../tools/tool-output.js'
import { raceAbort } from '../utils/abort.js'
import { ellipsize, trimLeadingLowSurrogate } from '../utils/ellipsize.js'
import { toErrorMessage } from '../utils/errors.js'
import { normalizeToolName } from '../utils/tool-name.js'
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

const require = createRequire(import.meta.url)
const { version: coralVersion } = require('../../package.json') as {
  version: string
}

const MAX_DISCOVERY_PAGES = 16
const MAX_DISCOVERED_TOOLS = 512
const MAX_TOOL_DESCRIPTION_CHARS = 2_000
const MAX_SCHEMA_CHARS = 25_000
const MAX_TOTAL_SCHEMA_CHARS = 100_000
const MAX_STATUS_MESSAGE_CHARS = 2_000
const MAX_STDERR_CHARS = 4_000
const MAX_STRUCTURED_CONTENT_CHARS = 80_000
const MAX_STRUCTURED_CONTENT_DEPTH = 20
const MAX_STRUCTURED_COLLECTION_ITEMS = 200

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
  // pinned per-session snapshot — every caller owns resolution
  config: McpConfigResolution
  permissions: ToolPermissions
  baseTools: readonly Tool[]
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
  transport: StdioClientTransport
  tools: McpSdkTool[]
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

function windowsExecutableNames(command: string): string[]
{
  if (process.platform !== 'win32' || extname(command)) return [command]
  return [command + '.EXE', command + '.COM']
}

async function executablePath(
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

function sanitizeDiagnostic(text: string): string
{
  return [...stripAnsi(text)]
    .map((character) =>
    {
      const code = character.codePointAt(0) ?? 0
      return code <= 8 || code === 11 || code === 12 || code === 127
        ? '�'
        : code >= 14 && code <= 31
          ? '�'
          : character
    })
    .join('')
}

function serializedSecret(value: string): string
{
  const json = JSON.stringify(value)
  return json.length >= 2 ? json.slice(1, -1) : ''
}

function normalizedSecrets(secretValues: readonly string[]): string[]
{
  const values = new Set<string>()
  for (const value of secretValues)
  {
    if (!value) continue
    const clean = sanitizeDiagnostic(value)
    for (const candidate of [value, clean, serializedSecret(value)])
    {
      if (candidate) values.add(candidate)
    }
  }
  return [...values].sort((left, right) => right.length - left.length)
}

function redactDiagnostic(
  text: string,
  secretValues: readonly string[]
): string
{
  let result = sanitizeDiagnostic(text)
  for (const value of normalizedSecrets(secretValues))
  {
    result =
      value.length >= 4
        ? result.replaceAll(value, '[redacted]')
        : redactShortValue(result, value)
  }
  return result
}

function isTokenCharacter(value: string | undefined): boolean
{
  if (!value) return false
  const code = value.codePointAt(0) ?? 0
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  )
}

function redactShortValue(text: string, value: string): string
{
  let result = ''
  let cursor = 0
  while (cursor < text.length)
  {
    const index = text.indexOf(value, cursor)
    if (index < 0)
    {
      result += text.slice(cursor)
      break
    }

    const before = index > 0 ? text[index - 1] : undefined
    const after = text[index + value.length]
    if (!isTokenCharacter(before) && !isTokenCharacter(after))
    {
      result += text.slice(cursor, index) + '[redacted]'
    }
    else
    {
      result += text.slice(cursor, index + value.length)
    }
    cursor = index + value.length
  }
  return result
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

// summary-only: detailed process output stays in the status stderr field
function statusMessage(
  error: unknown,
  secretValues: readonly string[] = []
): string
{
  return ellipsize(
    redactDiagnostic(toErrorMessage(error), secretValues),
    MAX_STATUS_MESSAGE_CHARS
  )
}

function schemaSize(schema: JsonSchema): number
{
  return JSON.stringify(schema).length
}

function sanitizeDescription(
  description: string | undefined,
  secretValues: readonly string[]
): string
{
  const clean = redactDiagnostic(description ?? 'MCP tool', secretValues)
  return ellipsize(clean, MAX_TOOL_DESCRIPTION_CHARS)
}

function schemaForModel(
  value: unknown,
  secretValues: readonly string[],
  key?: string
): unknown
{
  if (typeof value === 'string')
  {
    const clean = redactDiagnostic(value, secretValues)
    if (key === 'description' || key === 'title' || key === '$comment')
    {
      return ellipsize(clean, MAX_TOOL_DESCRIPTION_CHARS)
    }
    return clean
  }
  if (Array.isArray(value))
  {
    return value.map((item) => schemaForModel(item, secretValues))
  }
  if (typeof value === 'object' && value !== null)
  {
    const result: Record<string, unknown> = Object.create(null)
    for (const [childKey, childValue] of Object.entries(value))
    {
      const cleanKey = redactDiagnostic(childKey, secretValues)
      result[cleanKey] = schemaForModel(childValue, secretValues, childKey)
    }
    return result
  }
  return value
}

interface JsonBudget
{
  remaining: number
  truncated: boolean
}

const TRUNCATION_MARKER_COST = '"[truncated]"'.length

// pretty-print overhead JSON.stringify(bounded, null, 2) emits per item:
// two-space indentation at the item's depth plus separator & newline
function serializedItemOverhead(depth: number): number
{
  return 2 * (depth + 1) + 4
}

// the budget charges serialization overhead (indentation, separators,
// brackets, quotes, markers) alongside scalar contents so the emitted string
// tracks MAX_STRUCTURED_CONTENT_CHARS instead of overshooting on deep nesting
function boundedJsonValue(
  value: unknown,
  budget: JsonBudget,
  depth = 0
): unknown
{
  if (budget.remaining <= 0 || depth > MAX_STRUCTURED_CONTENT_DEPTH)
  {
    budget.truncated = true
    budget.remaining -= TRUNCATION_MARKER_COST
    return '[truncated]'
  }

  if (typeof value === 'string')
  {
    const length = Math.min(value.length, budget.remaining)
    budget.remaining -= length + 2
    if (length < value.length) budget.truncated = true
    return ellipsize(value, length)
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
  {
    budget.remaining -= String(value).length
    return value
  }
  if (Array.isArray(value))
  {
    // bracket lines & their indentation
    budget.remaining -= 2 * depth + 4
    const result: unknown[] = []
    for (const item of value.slice(0, MAX_STRUCTURED_COLLECTION_ITEMS))
    {
      if (budget.remaining <= 0) break
      budget.remaining -= serializedItemOverhead(depth)
      result.push(boundedJsonValue(item, budget, depth + 1))
    }
    if (result.length < value.length) budget.truncated = true
    return result
  }
  if (typeof value === 'object')
  {
    budget.remaining -= 2 * depth + 4
    const result: Record<string, unknown> = Object.create(null)
    const entries = Object.entries(value).slice(
      0,
      MAX_STRUCTURED_COLLECTION_ITEMS
    )
    for (const [key, item] of entries)
    {
      if (budget.remaining <= 0) break
      const keyLength = Math.min(key.length, budget.remaining)
      const boundedKey = ellipsize(key, keyLength)
      // key quotes & ': ' separator ride on the item overhead
      budget.remaining -= keyLength + serializedItemOverhead(depth) + 3
      if (keyLength < key.length) budget.truncated = true
      result[boundedKey] = boundedJsonValue(item, budget, depth + 1)
    }
    if (entries.length < Object.keys(value).length || budget.remaining <= 0)
    {
      budget.truncated = true
    }
    return result
  }

  budget.truncated = true
  return `[unsupported ${typeof value}]`
}

function formatStructuredContent(value: Record<string, unknown>): string
{
  const budget: JsonBudget = {
    remaining: MAX_STRUCTURED_CONTENT_CHARS,
    truncated: false,
  }
  const bounded = boundedJsonValue(value, budget)
  const label = budget.truncated
    ? '[structured content truncated]'
    : '[structured content]'
  return `${label}\n${JSON.stringify(bounded, null, 2)}`
}

function formatUnsupportedContent(
  content: CallToolResult['content'][number]
): string
{
  switch (content.type)
  {
    case 'image':
      return `[unsupported MCP image content: ${content.mimeType}]`
    case 'audio':
      return `[unsupported MCP audio content: ${content.mimeType}]`
    case 'resource':
      if ('text' in content.resource)
      {
        return `[MCP embedded resource: ${content.resource.uri}]\n${content.resource.text}`
      }
      return `[unsupported MCP binary resource: ${content.resource.uri}]`
    case 'resource_link':
      return `[unsupported MCP resource link: ${content.uri}]`
    default:
      return '[unsupported MCP content]'
  }
}

type McpOutputValidator = JsonSchemaValidator<Record<string, unknown>>

function formatToolResult(
  result: unknown,
  validateOutput: McpOutputValidator | undefined,
  secretValues: readonly string[]
): ToolResult
{
  if (
    typeof result !== 'object' ||
    result === null ||
    !('content' in result) ||
    !Array.isArray(result.content)
  )
  {
    return {
      output: '',
      error: 'MCP server returned an unsupported legacy tool result',
    }
  }

  const callResult = result as CallToolResult
  if (validateOutput && !callResult.isError)
  {
    if (!callResult.structuredContent)
    {
      return {
        output: '',
        error:
          'MCP tool declared an output schema but returned no structured content',
      }
    }
    const validation = validateOutput(callResult.structuredContent)
    if (!validation.valid)
    {
      return {
        output: '',
        error: `MCP structured output failed validation: ${ellipsize(redactDiagnostic(validation.errorMessage, secretValues), MAX_STATUS_MESSAGE_CHARS)}`,
      }
    }
  }

  const parts = callResult.content.map((content) =>
    content.type === 'text' ? content.text : formatUnsupportedContent(content)
  )

  if (callResult.structuredContent)
  {
    parts.push(formatStructuredContent(callResult.structuredContent))
  }

  const output = capToolOutput(
    redactDiagnostic(
      parts.filter((part) => part.length > 0).join('\n\n') ||
        '(MCP tool returned no supported content)',
      secretValues
    )
  )
  return callResult.isError
    ? {
        output,
        error: `MCP server reported a tool error: ${ellipsize(output, MAX_STATUS_MESSAGE_CHARS)}`,
      }
    : { output }
}

// NodeNext types this CJS default export as the module namespace
const addFormats =
  addFormatsModule as unknown as typeof addFormatsModule.default

const ajvOptions: AjvOptions = {
  strict: false,
  validateFormats: true,
  validateSchema: false,
  allErrors: true,
}

// MCP schemas default to the draft-2020-12 contract, but official SDK servers
// commonly advertise $schema-marked draft-07; compile under the declared dialect
const ajv2020 = addFormats(new Ajv2020(ajvOptions))
const ajvDraft07 = addFormats(new Ajv(ajvOptions))

function schemaValidator<T>(schema: JsonSchema): JsonSchemaValidator<T>
{
  const declared = (schema as { $schema?: unknown }).$schema
  const ajv =
    typeof declared === 'string' && declared.includes('draft-07')
      ? ajvDraft07
      : ajv2020
  const validate = ajv.compile(schema as Record<string, unknown>)
  return (input) =>
    validate(input)
      ? { valid: true, data: input as T, errorMessage: undefined }
      : {
          valid: false,
          data: undefined,
          errorMessage: ajv.errorsText(validate.errors),
        }
}

function inputValidator(
  toolName: string,
  schema: JsonSchema,
  secretValues: readonly string[]
): (args: Record<string, unknown>) => ToolArgumentValidation
{
  const validate = schemaValidator<Record<string, unknown>>(schema)

  return (args) =>
  {
    const result = validate(args)
    if (result.valid) return { ok: true, args: result.data }
    return {
      ok: false,
      error: `Invalid arguments for ${toolName}: ${ellipsize(redactDiagnostic(result.errorMessage, secretValues), MAX_STATUS_MESSAGE_CHARS)}. Fix the arguments & call the tool again.`,
    }
  }
}

const permissiveSdkValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T>
  {
    return (input) => ({
      valid: true,
      data: input as T,
      errorMessage: undefined,
    })
  },
}

// * Own one fixed set of local MCP clients for an interactive Agent
export class McpManager
{
  private readonly config: McpConfigResolution
  private readonly permissions: ToolPermissions
  private readonly baseTools: readonly Tool[]
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
    // normalized collisions are a superset of exact-name collisions
    const occupiedNormalizedNames = new Set(
      this.baseTools.map((tool) => normalizeToolName(tool.name))
    )
    let totalSchemaChars = 0
    let aborted = false

    for (const [index, server] of this.config.servers.entries())
    {
      if (options.signal?.aborted)
      {
        aborted = true
        break
      }
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

      const environment = this.resolveEnvironment(server, status)
      if (!environment) continue
      const secretValues = forwardedValues(server, environment)

      let connected: ConnectedServer | undefined
      try
      {
        const executable = await executablePath(
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

          // an abort during executable resolution must not open the prompt
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

        connected = await this.connectServer(
          server,
          executable,
          environment,
          status,
          allowedTools,
          secretValues,
          options.signal
        )
        const discovered = new Map(
          connected.tools.map((tool) => [tool.name, tool])
        )
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
            totalSchemaChars + chars > MAX_TOTAL_SCHEMA_CHARS
          )
          {
            status.message = `tool schema exceeds the MCP schema budget: ${rawName}`
            continue
          }

          let validateArgs: Tool['validateArgs']
          let validateOutput: McpOutputValidator | undefined
          try
          {
            validateArgs = inputValidator(name, schema, secretValues)
            if (outputSchema)
            {
              validateOutput =
                schemaValidator<Record<string, unknown>>(outputSchema)
            }
          }
          catch (error)
          {
            status.message = `invalid schema for ${rawName}: ${ellipsize(redactDiagnostic(toErrorMessage(error), secretValues), MAX_STATUS_MESSAGE_CHARS)}`
            continue
          }

          const tool: Tool = {
            name,
            description: sanitizeDescription(
              definition.description,
              secretValues
            ),
            parameters: schemaForModel(schema, secretValues) as JsonSchema,
            display: {
              label: `MCP · ${server.alias} · ${rawName}`,
            },
            validateArgs,
            execute: (args, context) =>
              this.callTool(
                session,
                rawName,
                args,
                server.toolTimeoutMs,
                validateOutput,
                context?.signal
              ),
          }

          occupiedNormalizedNames.add(normalized)
          totalSchemaChars += chars
          serverTools.push(tool)
        }

        if (serverTools.length === 0)
        {
          await connected.client.close()
          status.state = 'failed'
          status.message ??= 'server exposed no usable allowlisted tools'
          continue
        }
        if (connected.transport.pid === null)
        {
          await connected.client.close().catch(() => undefined)
          status.state = 'failed'
          status.message = 'MCP server exited during startup'
          continue
        }

        this.sessions.push(session)
        this.tools.push(...serverTools)
        status.state = 'ready'
        status.availableTools = serverTools.map((tool) => tool.name)
      }
      catch (error)
      {
        if (connected) await connected.client.close().catch(() => undefined)
        if (isAbortError(error) || options.signal?.aborted)
        {
          status.state = 'stopped'
          status.message = 'startup interrupted'
          aborted = true
          break
        }
        status.state = 'failed'
        status.message = statusMessage(error, secretValues)
      }
    }

    if (aborted || options.signal?.aborted)
    {
      await this.rollbackInitialization()
      return []
    }

    return [...this.tools]
  }

  private async rollbackInitialization(): Promise<void>
  {
    for (const session of this.sessions)
    {
      session.active = false
      session.status.state = 'stopped'
      session.status.message = 'startup interrupted; restart Coral to retry'
    }
    await Promise.allSettled(
      this.sessions.map((session) => session.client.close())
    )
    this.sessions = []
    this.tools = []
  }

  private resolveEnvironment(
    server: McpServerConfig,
    status: McpServerStatus
  ): Record<string, string> | null
  {
    const environment = getDefaultEnvironment()
    const missing = server.passEnv.filter(
      (name) => process.env[name] === undefined
    )
    if (missing.length > 0)
    {
      status.state = 'failed'
      status.message = `missing required environment variable(s): ${missing.join(', ')}`
      return null
    }

    for (const name of server.passEnv)
    {
      environment[name] = process.env[name]!
    }
    return environment
  }

  // secretValues is the caller's forwarded-value list — one derivation keeps
  // stderr & session redaction from desynchronizing
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
    const transport = new StdioClientTransport({
      command: executable,
      args: server.args,
      env: environment,
      cwd: server.launchCwd,
      stderr: 'pipe',
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
      status.message = statusMessage(error, secretValues)
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
    validateOutput: McpOutputValidator | undefined,
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
        return formatToolResult(result, validateOutput, session.secretValues)
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
        return {
          output: '',
          error: `MCP tool call failed: ${ellipsize(redactDiagnostic(toErrorMessage(error), session.secretValues), MAX_STATUS_MESSAGE_CHARS)}`,
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
