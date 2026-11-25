// src/tools/bash.ts
// execute shell commands and return output

import { existsSync } from 'node:fs'
import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import { getCwd } from '../cwd.js'
import {
  DEFAULT_CHILD_PROCESS_MAX_BUFFER,
  runProcessGroup,
  type ProcessGroupResult,
} from '../utils/process.js'
import { MAX_ERROR_MESSAGE_CHARS } from '../utils/limits.js'
import { isUnsafeTerminalControl } from '../utils/untrusted-text.js'
import { capToolOutput } from './tool-output.js'

export const BASH_DEFAULT_TIMEOUT_MS = 30_000

// the usual path, or PATH lookup on systems w/o one (NixOS, some containers)
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash'

// setTimeout turns anything above this into a 1 ms timer
const MAX_TIMEOUT_MS = 2_147_483_647

// raw control bytes hide what a command does on the approval prompt, so the
// model must spell them as escapes; tab & newline stay allowed
function controlByteError(command: string): string | undefined
{
  let index = 0
  for (const char of command)
  {
    const code = char.codePointAt(0)!
    if (isUnsafeTerminalControl(code))
    {
      const hex = code.toString(16).toUpperCase().padStart(4, '0')
      const prefix =
        `bash refuses commands containing raw control characters ` +
        `(U+${hex} at character ${index})`
      if (code === 0x0d)
      {
        return `${prefix}; CR and CRLF line endings are not allowed, send the command with LF-only (\\n) line endings`
      }
      return `${prefix}; write it as an escape such as $'\\x1b' or printf '\\033' instead`
    }
    index++
  }
  return undefined
}

// why the command failed, as one line the model can act on
function failureCause(result: ProcessGroupResult, timeout: number): string
{
  if (result.launchError) return `[could not start: ${result.launchError}]`
  if (result.stopped === 'timeout')
  {
    return `[timed out after ${timeout} ms; the command and its child processes were stopped]`
  }
  if (result.stopped === 'abort')
  {
    return '[cancelled; the command and its child processes were stopped]'
  }
  if (result.signal) return `[killed by ${result.signal}]`
  return `[exit code ${String(result.exitCode)}]`
}

// the cause leads & stderr keeps its head & tail within the loop's error
// cap, so the model sees why it failed however much stderr there was
function failureError(result: ProcessGroupResult, timeout: number): string
{
  const cause = failureCause(result, timeout)
  const stderr = result.stderr.trim()
  if (!stderr) return cause
  const budget = MAX_ERROR_MESSAGE_CHARS - cause.length - 1
  return `${cause}\n${capToolOutput(stderr, budget, { preserveTail: true })}`
}

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a bash command and return its output.',
  display: { label: 'Shell', summarize: (args) => String(args.command ?? '') },
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      timeout: {
        type: 'number',
        description:
          'Timeout in milliseconds, a positive whole number (default 30000)',
      },
    },
    required: ['command'],
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const command = args.command
    if (typeof command !== 'string' || !command.trim())
    {
      return { output: '', error: 'bash requires a non-empty command' }
    }
    const controlError = controlByteError(command)
    if (controlError) return { output: '', error: controlError }
    const timeout =
      (args.timeout as number | undefined) ?? BASH_DEFAULT_TIMEOUT_MS
    if (
      !Number.isInteger(timeout) ||
      timeout <= 0 ||
      timeout > MAX_TIMEOUT_MS
    )
    {
      return {
        output: '',
        error: `bash timeout must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}, got ${String(timeout)}; omit it for the ${BASH_DEFAULT_TIMEOUT_MS} ms default`,
      }
    }

    const result = await runProcessGroup(BASH, ['-c', command], {
      cwd: context?.cwd ?? getCwd(),
      timeout,
      maxOutput: DEFAULT_CHILD_PROCESS_MAX_BUFFER,
      signal: context?.signal,
    })
    if (result.exitCode !== 0 || result.stopped || result.launchError)
    {
      return { output: result.stdout, error: failureError(result, timeout) }
    }

    return {
      output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
    }
  },
}
