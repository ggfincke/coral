// src/tools/grep.ts
// search file contents by regex pattern via ripgrep

import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import {
  execRipgrep,
  NO_MATCHES_MESSAGE,
  resolveRgSearchTarget,
  RG_EXCLUDE_GIT_DIR,
} from './ripgrep-utils.js'

const MAX_RESULTS = 200

function normalizeProjectGrepOutput(output: string): string
{
  return output.replace(/(^|\n)\.\//g, '$1')
}

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents by regex pattern. Returns matching lines w/ file paths & line numbers. Requires ripgrep (rg) to be installed.',
  subagentSafe: true,
  parallelSafe: true,
  display: {
    label: 'Search',
    summarize: (args) =>
    {
      const pattern = String(args.pattern ?? '')
      const path = args.path ? ` ${String(args.path)}` : ''
      return `${pattern}${path}`
    },
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: {
        type: 'string',
        description: 'Directory to search in (default: working directory)',
      },
      include: {
        type: 'string',
        description:
          "Glob pattern to filter files (e.g., '*.ts', '*.{js,jsx}')",
      },
    },
    required: ['pattern'],
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const pattern = args.pattern as string
    const { searchPath, cwd, isProjectPath, error } =
      await resolveRgSearchTarget(
        args.path as string | undefined,
        context?.cwd,
        context?.allowOutsideWorkspace === true
      )
    if (error)
    {
      return { output: '', error }
    }
    const include = args.include as string | undefined

    const rgArgs = [
      '-n',
      '-H',
      '--hidden',
      '--no-messages',
      '--regexp',
      pattern,
    ]

    if (include)
    {
      rgArgs.push('--glob', include)
    }
    rgArgs.push(...RG_EXCLUDE_GIT_DIR)

    // '--' ends rg options so a model-supplied path can never act as a flag
    rgArgs.push('--', searchPath)

    const result = await execRipgrep(rgArgs, NO_MATCHES_MESSAGE, {
      cwd: isProjectPath ? cwd : undefined,
      signal: context?.signal,
      maxItems: MAX_RESULTS,
      label: 'matches',
    })
    if (result.error || result.output === NO_MATCHES_MESSAGE) return result

    return isProjectPath
      ? { output: normalizeProjectGrepOutput(result.output) }
      : result
  },
}
