// src/cli/exec.ts
// run one deterministic headless Agent turn and emit machine-readable evidence

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { resolve } from 'node:path'
import {
  type CliOptions,
  type ExecPermissionProfile,
  type ExecOutputFormat,
} from './args.js'
import { Agent } from '../agent/agent.js'
import type { AgentInferenceClient, TokenUsage } from '../agent/agent.js'
import {
  SURFACE_MAX_ITERATIONS,
  type AgentRunOutcome,
} from '../agent/contracts.js'
import { resolveMcpConfig } from '../config/mcp.js'
import {
  resolvePermissions,
  type ToolPermissions,
} from '../config/permissions.js'
import { normalizeOllamaHost } from '../ollama/host.js'
import { discoverSkills, loadUserInstructions } from '../skills/discover.js'
import { allTools, subagentTools } from '../tools/registry.js'
import type { Tool } from '../tools/tool.js'
import { toErrorMessage } from '../utils/errors.js'
import { agentsHomePath } from '../utils/agents-home.js'
import { writeUserJsonFile } from '../utils/json.js'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'

export type ExecStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'iteration_limited'
  | 'doom_loop_stopped'

export interface CoralExecOptions
{
  prompt: string
  think?: boolean
  cwd: string
  model: string
  host: string
  permissionProfile: ExecPermissionProfile
  outputFormat: ExecOutputFormat
  resultFile?: string
  mcp: boolean
}

export interface CoralExecResult
{
  version: 1
  run_id: string
  status: ExecStatus
  model: string
  response: string
  usage: {
    prompt_tokens: number
    completion_tokens: number
    prompt_eval_duration_ns: number
    eval_duration_ns: number
  }
  error?: string
}

export interface HeadlessProfile
{
  tools: readonly Tool[]
  permissions: ToolPermissions
}

export interface CoralExecDependencies
{
  inferenceClient?: AgentInferenceClient
  createRunId?: () => string
  writeStdout?: (text: string) => void
  writeStderr?: (text: string) => void
  // whether each stream is a terminal; defaults to the process streams
  stdoutIsTTY?: boolean
  stderrIsTTY?: boolean
}

const WORKSPACE_WRITE_TOOL_NAMES = new Set([
  ...subagentTools.map((tool) => tool.name),
  'write_file',
  'edit_file',
  'bash',
])

const MAX_PROMPT_BYTES = 1_048_576

export function resolveHeadlessProfile(
  profile: ExecPermissionProfile
): HeadlessProfile
{
  const tools =
    profile === 'none'
      ? []
      : profile === 'read-only'
        ? subagentTools
        : allTools.filter((tool) => WORKSPACE_WRITE_TOOL_NAMES.has(tool.name))
  const permissions = Object.fromEntries(
    tools.map((tool) => [tool.name, 'always_allow'] as const)
  ) as ToolPermissions
  return { tools, permissions }
}

// configured always_deny still wins over the profile's forced allow map
function resolveHeadlessPermissions(
  profile: HeadlessProfile,
  cwd: string,
  mcp: boolean
): ToolPermissions
{
  const permissions = { ...profile.permissions }
  for (const [name, policy] of Object.entries(resolvePermissions(cwd)))
  {
    if (mcp && name.startsWith('mcp__')) permissions[name] = policy
    else if (policy === 'always_deny' && Object.hasOwn(permissions, name))
      permissions[name] = policy
  }
  return permissions
}

// read the Agent's settled outcome; an abort always reports cancelled
function execStatus(
  outcome: AgentRunOutcome | undefined,
  runError: Error | undefined,
  aborted: boolean
): ExecStatus
{
  if (runError || !outcome || outcome.status === 'failed') return 'failed'
  if (aborted) return 'cancelled'
  switch (outcome.status)
  {
    case 'completed':
      return 'completed'
    case 'iteration_limit':
      return 'iteration_limited'
    case 'doom_loop_stopped':
      return 'doom_loop_stopped'
    case 'cancelled':
    case 'stopped':
      return 'cancelled'
  }
}

function latestAssistantResponse(agent: Agent): string | undefined
{
  return agent.getMessages().findLast((message) => message.role === 'assistant')
    ?.content
}

function usageResult(agent: Agent): CoralExecResult['usage']
{
  const usage = agent.getTokenUsage()
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    prompt_eval_duration_ns: usage.promptEvalDurationNs,
    eval_duration_ns: usage.evalDurationNs,
  }
}

// model and server text bound for a terminal drops control sequences, while
// pipes keep the raw bytes
function terminalText(text: string, isTTY: boolean): string
{
  return isTTY ? sanitizeUntrustedText(text) : text
}

function emitResult(
  result: CoralExecResult,
  format: ExecOutputFormat,
  writeStdout: (text: string) => void,
  stdoutIsTTY: boolean
): void
{
  if (format === 'stream-json')
  {
    writeStdout(`${JSON.stringify({ type: 'result', ...result })}\n`)
  }
  else if (format === 'json')
  {
    writeStdout(`${JSON.stringify(result)}\n`)
  }
  else if (result.response)
  {
    writeStdout(`${terminalText(result.response, stdoutIsTTY)}\n`)
  }
}

export async function runCoralExec(
  options: CoralExecOptions,
  dependencies: CoralExecDependencies = {},
  signal?: AbortSignal
): Promise<CoralExecResult>
{
  const writeStdout =
    dependencies.writeStdout ?? ((text: string) => process.stdout.write(text))
  const writeStderr =
    dependencies.writeStderr ?? ((text: string) => process.stderr.write(text))
  const stdoutIsTTY = dependencies.stdoutIsTTY ?? process.stdout.isTTY === true
  const stderrIsTTY = dependencies.stderrIsTTY ?? process.stderr.isTTY === true
  const emit = (event: Record<string, unknown>): void =>
  {
    if (options.outputFormat === 'stream-json')
    {
      writeStdout(`${JSON.stringify(event)}\n`)
    }
  }
  const runId = dependencies.createRunId?.() ?? randomUUID()
  const profile = resolveHeadlessProfile(options.permissionProfile)
  const mcp = options.mcp && options.permissionProfile !== 'none'
  const agentsHome = agentsHomePath()
  const skills = discoverSkills({ cwd: options.cwd, agentsHome })
  const agent = new Agent(options.model, options.host, options.cwd, {
    tools: profile.tools,
    permissions: resolveHeadlessPermissions(profile, options.cwd, mcp),
    maxIterations: SURFACE_MAX_ITERATIONS,
    mcpMode: mcp ? 'ask' : 'off',
    mcpConfig: mcp ? resolveMcpConfig() : { servers: [], issues: [] },
    verifyEdits: false,
    think: options.think ?? true,
    skills,
    userInstructions: loadUserInstructions(agentsHome),
    ...(dependencies.inferenceClient
      ? { inferenceClient: dependencies.inferenceClient }
      : {}),
  })
  let streamedResponse = ''
  let runError: Error | undefined
  let outcome: AgentRunOutcome | undefined
  let doomLoopMessage: string | undefined

  try
  {
    emit({ type: 'init', run_id: runId, model: options.model })
    outcome = await agent.run(
      options.prompt,
      {
        onToken(token)
        {
          streamedResponse += token
          emit({ type: 'assistant_delta', text: token, run_id: runId })
        },
        onThinking(thinking)
        {
          emit({ type: 'thinking_delta', text: thinking, run_id: runId })
        },
        onToolCall(name, args, callId)
        {
          emit({
            type: 'tool_call',
            name,
            args,
            call_id: callId,
            run_id: runId,
          })
        },
        onToolResult(name, output, error, callId, diff)
        {
          emit({
            type: 'tool_result',
            name,
            output,
            error,
            call_id: callId,
            diff,
            run_id: runId,
          })
        },
        async onToolApproval(name, args)
        {
          emit({ type: 'approval_rejected', name, args, run_id: runId })
          return false
        },
        async onMcpLaunchApproval(request)
        {
          emit({
            type: 'mcp_launch_rejected',
            alias: request.alias,
            run_id: runId,
          })
          return false
        },
        async onDoomLoop(message)
        {
          doomLoopMessage = message
          emit({ type: 'doom_loop_stopped', message, run_id: runId })
          return false
        },
        onUsage(usage: TokenUsage)
        {
          emit({ type: 'usage', usage, run_id: runId })
        },
        onDone()
        {
          emit({ type: 'done', run_id: runId })
        },
        onError(error)
        {
          runError = error
          emit({ type: 'error', error: error.message, run_id: runId })
        },
      },
      signal
    )
  }
  catch (error)
  {
    runError = error instanceof Error ? error : new Error(String(error))
    emit({ type: 'error', error: runError.message, run_id: runId })
  }
  finally
  {
    try
    {
      await agent.dispose()
    }
    catch (error)
    {
      runError ??= error instanceof Error ? error : new Error(String(error))
    }
  }

  const status = execStatus(outcome, runError, signal?.aborted === true)
  const finalResponse = latestAssistantResponse(agent) ?? streamedResponse
  const error =
    runError?.message ??
    (status === 'doom_loop_stopped'
      ? `stopped by the doom-loop guard: ${doomLoopMessage ?? 'repeated tool calls'}`
      : undefined)
  let result: CoralExecResult = {
    version: 1,
    run_id: runId,
    status,
    model: options.model,
    response: finalResponse.trim(),
    usage: usageResult(agent),
    ...(error ? { error } : {}),
  }
  if (options.resultFile)
  {
    try
    {
      writeUserJsonFile(options.resultFile, result)
    }
    catch (error)
    {
      const writeError = `failed to write result file: ${toErrorMessage(error)}`
      result = {
        ...result,
        status: 'failed',
        error: result.error ? `${result.error}; ${writeError}` : writeError,
      }
    }
  }
  emitResult(result, options.outputFormat, writeStdout, stdoutIsTTY)
  if (result.error) writeStderr(`${terminalText(result.error, stderrIsTTY)}\n`)
  return result
}

// bound bytes as they arrive and detach every listener on completion or cancellation
export function readPromptStream(
  stream: Readable,
  signal?: AbortSignal
): Promise<string>
{
  return new Promise((resolveText, reject) =>
  {
    const chunks: Buffer[] = []
    let bytes = 0
    const cleanup = () =>
    {
      stream.pause()
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const onError = (error: unknown) =>
    {
      cleanup()
      reject(error)
    }
    const onAbort = () => onError(new Error('Prompt input cancelled'))
    const onEnd = () =>
    {
      cleanup()
      resolveText(Buffer.concat(chunks).toString('utf8'))
    }
    const onData = (chunk: Buffer | string) =>
    {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > MAX_PROMPT_BYTES)
      {
        onError(new Error(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`))
        return
      }
      chunks.push(buffer)
    }
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

async function resolveExecPrompt(
  prompt: string | undefined,
  promptFile: string | undefined,
  signal: AbortSignal
): Promise<string>
{
  if (prompt !== undefined && promptFile !== undefined)
    throw new Error(
      'provide either a prompt argument or --prompt-file, not both'
    )
  let value = prompt
  if (promptFile)
  {
    if (promptFile === '-' && process.stdin.isTTY)
      throw new Error('--prompt-file - requires piped stdin')
    const stream =
      promptFile === '-' ? process.stdin : createReadStream(resolve(promptFile))
    try
    {
      value = await readPromptStream(stream, signal)
    }
    finally
    {
      if (stream !== process.stdin) stream.destroy()
    }
  }
  if (!value?.trim()) throw new Error('a nonempty prompt is required')
  if (Buffer.byteLength(value) > MAX_PROMPT_BYTES)
    throw new Error(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`)
  return value
}

export async function runExecCli(opts: CliOptions): Promise<number>
{
  const controller = new AbortController()
  let receivedSignal: 'SIGINT' | 'SIGTERM' | undefined
  const abortFor = (signal: 'SIGINT' | 'SIGTERM') => () =>
  {
    receivedSignal ??= signal
    controller.abort(signal)
  }
  const interrupt = abortFor('SIGINT')
  const terminate = abortFor('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  let started = false

  try
  {
    const cwd = resolve(opts.cwd ?? process.cwd())
    if (!(await stat(cwd)).isDirectory())
      throw new Error(`not a directory: ${cwd}`)
    const model = opts.model?.trim()
    if (!model) throw new Error('model must be nonempty; use -m <model>')
    const host = normalizeOllamaHost(opts.host)
    const prompt = await resolveExecPrompt(
      opts.prompt,
      opts.promptFile,
      controller.signal
    )
    controller.signal.throwIfAborted()
    started = true
    const result = await runCoralExec(
      {
        prompt,
        cwd,
        model,
        host,
        think: opts.think,
        permissionProfile: opts.permissionProfile,
        outputFormat: opts.outputFormat,
        resultFile: opts.resultFile ? resolve(opts.resultFile) : undefined,
        mcp: opts.mcp,
      },
      {},
      controller.signal
    )
    return receivedSignal
      ? receivedSignal === 'SIGTERM'
        ? 143
        : 130
      : result.status === 'completed'
        ? 0
        : 1
  }
  catch (error)
  {
    let resultWriteFailed = false
    let result: CoralExecResult = {
      version: 1,
      run_id: randomUUID(),
      status: controller.signal.aborted ? 'cancelled' : 'failed',
      model: opts.model ?? '',
      response: '',
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        prompt_eval_duration_ns: 0,
        eval_duration_ns: 0,
      },
      error: toErrorMessage(error),
    }
    if (opts.resultFile)
    {
      try
      {
        writeUserJsonFile(resolve(opts.resultFile), result)
      }
      catch (writeError)
      {
        resultWriteFailed = true
        result = {
          ...result,
          error: `${result.error}; failed to write result file: ${toErrorMessage(writeError)}`,
        }
      }
    }
    emitResult(
      result,
      opts.outputFormat,
      (text) => process.stdout.write(text),
      process.stdout.isTTY === true
    )
    process.stderr.write(
      `${terminalText(result.error ?? '', process.stderr.isTTY === true)}\n`
    )
    return receivedSignal
      ? receivedSignal === 'SIGTERM'
        ? 143
        : 130
      : started || resultWriteFailed
        ? 1
        : 2
  }
  finally
  {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}
