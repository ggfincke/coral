// src/cli/exec.ts
// run one deterministic headless Agent turn and emit machine-readable evidence

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { resolve } from 'node:path'
import {
  parseCliArgs,
  type CliOptions,
  type ExecPermissionProfile,
  type ExecOutputFormat,
} from './args.js'
export type { ExecPermissionProfile, ExecOutputFormat } from './args.js'
import { Agent } from '../agent/agent.js'
import type { AgentInferenceClient, TokenUsage } from '../agent/agent.js'
import { resolveMcpConfig } from '../config/mcp.js'
import {
  resolvePermissions,
  type ToolPermissions,
} from '../config/permissions.js'
import { normalizeOllamaHost } from '../ollama/host.js'
import { allTools, subagentTools } from '../tools/registry.js'
import type { Tool } from '../tools/tool.js'
import { toErrorMessage } from '../utils/errors.js'
import { writeJsonFile } from '../utils/json.js'

export type ExecStatus = 'completed' | 'failed' | 'cancelled'

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
    profile === 'read-only'
      ? subagentTools
      : allTools.filter((tool) => WORKSPACE_WRITE_TOOL_NAMES.has(tool.name))
  const permissions = Object.fromEntries(
    tools.map((tool) => [tool.name, 'always_allow'] as const)
  ) as ToolPermissions
  return { tools, permissions }
}

function resolveHeadlessPermissions(
  profile: HeadlessProfile,
  cwd: string,
  mcp: boolean
): ToolPermissions
{
  if (!mcp) return profile.permissions
  const permissions = { ...profile.permissions }
  for (const [name, policy] of Object.entries(resolvePermissions(cwd)))
  {
    if (name.startsWith('mcp__')) permissions[name] = policy
  }
  return permissions
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

function emitResult(
  result: CoralExecResult,
  format: ExecOutputFormat,
  writeStdout: (text: string) => void
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
    writeStdout(`${result.response}\n`)
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
  const emit = (event: Record<string, unknown>): void =>
  {
    if (options.outputFormat === 'stream-json')
    {
      writeStdout(`${JSON.stringify(event)}\n`)
    }
  }
  const runId = dependencies.createRunId?.() ?? randomUUID()
  const profile = resolveHeadlessProfile(options.permissionProfile)
  const agent = new Agent(options.model, options.host, options.cwd, {
    tools: profile.tools,
    permissions: resolveHeadlessPermissions(profile, options.cwd, options.mcp),
    mcpMode: options.mcp ? 'ask' : 'off',
    mcpConfig: options.mcp ? resolveMcpConfig() : { servers: [], issues: [] },
    verifyEdits: false,
    think: options.think ?? true,
    ...(dependencies.inferenceClient
      ? { inferenceClient: dependencies.inferenceClient }
      : {}),
  })
  let streamedResponse = ''
  let runError: Error | undefined

  try
  {
    emit({ type: 'init', run_id: runId, model: options.model })
    await agent.run(
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

  const status: ExecStatus = runError
    ? 'failed'
    : signal?.aborted
      ? 'cancelled'
      : 'completed'
  const finalResponse = latestAssistantResponse(agent) ?? streamedResponse
  let result: CoralExecResult = {
    version: 1,
    run_id: runId,
    status,
    model: options.model,
    response: finalResponse.trim(),
    usage: usageResult(agent),
    ...(runError ? { error: runError.message } : {}),
  }
  if (options.resultFile)
  {
    try
    {
      writeJsonFile(options.resultFile, result)
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
  emitResult(result, options.outputFormat, writeStdout)
  if (result.error) writeStderr(`${result.error}\n`)
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

export async function runExecCli(
  input: string[] | CliOptions
): Promise<number>
{
  const parsed = Array.isArray(input)
    ? parseCliArgs(['exec', ...input])
    : { kind: 'exec' as const, options: input }
  if (parsed.kind === 'exit') return parsed.code
  const opts = parsed.options
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
    if (!model) throw new Error('model must be nonempty; use -m <Ollama model>')
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
        writeJsonFile(resolve(opts.resultFile), result)
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
    emitResult(result, opts.outputFormat, (text) => process.stdout.write(text))
    process.stderr.write(`${result.error}\n`)
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
