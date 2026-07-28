// src/cli/exec.ts
// run one deterministic headless Agent turn and emit machine-readable evidence

import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Command, CommanderError, Option } from 'commander'
import { Agent } from '../agent/agent.js'
import type { AgentInferenceClient, TokenUsage } from '../agent/agent.js'
import { resolveMcpConfig } from '../config/mcp.js'
import {
  resolvePermissions,
  type ToolPermissions,
} from '../config/permissions.js'
import { DEFAULT_OLLAMA_HOST, normalizeOllamaHost } from '../ollama/host.js'
import { allTools, subagentTools } from '../tools/registry.js'
import type { Tool } from '../tools/tool.js'
import { toErrorMessage } from '../utils/errors.js'
import { writeJsonFile } from '../utils/json.js'

export type ExecPermissionProfile = 'read-only' | 'workspace-write'
export type ExecOutputFormat = 'text' | 'json' | 'stream-json'
export type ExecStatus = 'completed' | 'failed' | 'cancelled'

export interface CoralExecOptions
{
  prompt: string
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

async function resolveExecPrompt(
  prompt: string | undefined,
  promptFile: string | undefined
): Promise<string>
{
  if (prompt && promptFile)
  {
    throw new Error(
      'provide either a prompt argument or --prompt-file, not both'
    )
  }
  let value = prompt
  if (promptFile)
  {
    const buffer = await readFile(resolve(promptFile))
    if (buffer.byteLength > MAX_PROMPT_BYTES)
    {
      throw new Error(`prompt file exceeds ${MAX_PROMPT_BYTES} bytes`)
    }
    value = buffer.toString('utf-8')
  }
  if (!value?.trim()) throw new Error('a nonempty prompt is required')
  return value
}

export async function runExecCli(argv: string[]): Promise<number>
{
  let exitCode = 0
  const command = new Command()
    .name('coral exec')
    .description('Run one noninteractive Coral agent turn')
    .argument('[prompt]', 'prompt text; quote multiword prompts')
    .requiredOption('-m, --model <model>', 'Ollama model to use')
    .option('--prompt-file <path>', 'read the prompt from a UTF-8 file')
    .option('--cwd <path>', 'workspace directory', process.cwd())
    .option('--host <url>', 'Ollama host URL', DEFAULT_OLLAMA_HOST)
    .addOption(
      new Option('--permission-profile <profile>', 'headless tool profile')
        .choices(['read-only', 'workspace-write'])
        .default('read-only')
    )
    .addOption(
      new Option('--output-format <format>', 'stdout format')
        .choices(['text', 'json', 'stream-json'])
        .default('text')
    )
    .option('--result-file <path>', 'atomically write the structured result')
    .option('--ephemeral', 'do not persist a Coral conversation')
    .addOption(
      new Option(
        '--mcp',
        'enable pre-trusted, always-allowed MCP tools'
      ).default(false)
    )
    .option('--no-mcp', 'explicitly disable configured MCP servers')
    .exitOverride()
    .action(
      async (
        prompt: string | undefined,
        opts: {
          model: string
          promptFile?: string
          cwd: string
          host: string
          permissionProfile: ExecPermissionProfile
          outputFormat: ExecOutputFormat
          resultFile?: string
          mcp: boolean
        }
      ) =>
      {
        const cwd = resolve(opts.cwd)
        const cwdStat = await stat(cwd)
        if (!cwdStat.isDirectory()) throw new Error(`not a directory: ${cwd}`)
        const model = opts.model.trim()
        if (!model) throw new Error('model must be nonempty')
        const controller = new AbortController()
        let receivedSignal: 'SIGINT' | 'SIGTERM' | undefined
        const abortFor = (signal: 'SIGINT' | 'SIGTERM') => (): void =>
        {
          receivedSignal ??= signal
          controller.abort(signal)
        }
        const abortOnSigint = abortFor('SIGINT')
        const abortOnSigterm = abortFor('SIGTERM')
        process.once('SIGINT', abortOnSigint)
        process.once('SIGTERM', abortOnSigterm)
        try
        {
          const result = await runCoralExec(
            {
              prompt: await resolveExecPrompt(prompt, opts.promptFile),
              cwd,
              model,
              host: normalizeOllamaHost(opts.host),
              permissionProfile: opts.permissionProfile,
              outputFormat: opts.outputFormat,
              ...(opts.resultFile
                ? { resultFile: resolve(opts.resultFile) }
                : {}),
              mcp: opts.mcp,
            },
            {},
            controller.signal
          )
          exitCode =
            result.status === 'completed'
              ? 0
              : result.status === 'cancelled'
                ? receivedSignal === 'SIGTERM'
                  ? 143
                  : 130
                : 1
        }
        finally
        {
          process.off('SIGINT', abortOnSigint)
          process.off('SIGTERM', abortOnSigterm)
        }
      }
    )

  try
  {
    await command.parseAsync(argv, { from: 'user' })
  }
  catch (error)
  {
    if (error instanceof CommanderError)
    {
      return error.exitCode
    }
    process.stderr.write(`${toErrorMessage(error)}\n`)
    return 2
  }
  return exitCode
}
