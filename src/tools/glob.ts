// src/tools/glob.ts
// find files by name pattern via ripgrep

import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import { execRipgrep, NO_MATCHING_FILES_MESSAGE } from './ripgrep-utils.js'
import { getCwd, resolvePath } from '../cwd.js'
import {
  formatProjectPath,
  isPathInsideProject,
} from '../shared/project-tree.js'
import { truncateOutput } from '../utils/truncate-output.js'

const MAX_FILES = 100

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files by name/path glob pattern. Returns matching file paths sorted by modification time (newest first). Requires ripgrep (rg) to be installed.',
  subagentSafe: true,
  parallelSafe: true,
  display: { label: 'Glob', summarize: (args) => String(args.pattern ?? '') },
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          "Glob pattern to match files (e.g., '**/*.ts', 'src/**/test*')",
      },
      path: {
        type: 'string',
        description: 'Directory to search in (default: working directory)',
      },
    },
    required: ['pattern'],
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const pattern = args.pattern as string
    const cwd = getCwd()
    const path = resolvePath((args.path as string) ?? '.')
    const isProjectPath = isPathInsideProject(cwd, path)
    const searchPath = isProjectPath ? formatProjectPath(cwd, path) : path

    const rgArgs = [
      '--files',
      '--hidden',
      '--sortr=modified',
      '--glob',
      pattern,
    ]

    if (searchPath !== '.') rgArgs.push(searchPath)

    const result = await execRipgrep(rgArgs, NO_MATCHING_FILES_MESSAGE, {
      cwd: isProjectPath ? cwd : undefined,
      signal: context?.signal,
    })
    if (result.error || result.output === NO_MATCHING_FILES_MESSAGE)
      return result

    return { output: truncateOutput(result.output, MAX_FILES, 'files') }
  },
}
