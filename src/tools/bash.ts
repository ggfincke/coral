// src/tools/bash.ts
// execute shell commands & return output

import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import { getCwd } from '../cwd.js'
import {
  DEFAULT_CHILD_PROCESS_MAX_BUFFER,
  execShellCommand,
  formatProcessError,
} from '../utils/process.js'

const DEFAULT_TIMEOUT = 30_000

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
        description: 'Timeout in milliseconds (default 30000)',
      },
    },
    required: ['command'],
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const command = args.command as string
    const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT

    const result = await execShellCommand(command, {
      cwd: context?.cwd ?? getCwd(),
      timeout,
      maxBuffer: DEFAULT_CHILD_PROCESS_MAX_BUFFER,
      signal: context?.signal,
    })
    if (!result.ok)
    {
      return {
        output: result.stdout || '',
        error: formatProcessError(result),
      }
    }

    return {
      output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
    }
  },
}
