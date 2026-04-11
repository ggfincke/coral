// src/tools/git.ts
// git tools for status, diff, & log

import { execSync } from 'node:child_process'
import type { Tool, ToolResult } from './tool.js'
import { getCwd } from '../cwd.js'

const GIT_TIMEOUT = 10_000
const MAX_BUFFER = 1024 * 1024

// run a git command & return the output or an error
function runGit(args: string[], cwd: string): ToolResult
{
  try
  {
    const output = execSync(`git ${args.join(' ')}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT,
      maxBuffer: MAX_BUFFER,
    })

    return { output: output.trimEnd() || '(no output)' }
  }
  catch (err: unknown)
  {
    const execErr = err as { stdout?: string; stderr?: string; message?: string }

    // git diff returns exit code 1 in some configs even w/ valid output
    if (execErr.stdout)
    {
      return { output: execErr.stdout.trimEnd() }
    }

    return {
      output: '',
      error: execErr.stderr?.trim() || execErr.message || 'git command failed',
    }
  }
}

export const gitStatusTool: Tool = {
  name: 'git_status',
  description: 'Show the working tree status (staged, unstaged, & untracked files).',
  parameters: {
    type: 'object',
    properties: {
      short: {
        type: 'boolean',
        description: 'Use short format output (default true)',
      },
    },
  },
  async execute(args): Promise<ToolResult>
  {
    const short = (args.short as boolean) ?? true
    const flags = short ? ['status', '--short'] : ['status']
    return runGit(flags, getCwd())
  },
}

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description: 'Show changes between commits, staging area, & working tree.',
  parameters: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'Show staged (cached) changes instead of unstaged',
      },
      ref: {
        type: 'string',
        description: 'Git ref or range to diff against (e.g., "HEAD~1", "main..HEAD")',
      },
      path: {
        type: 'string',
        description: 'Limit diff to a specific file or directory path',
      },
    },
  },
  async execute(args): Promise<ToolResult>
  {
    const staged = args.staged as boolean | undefined
    const ref = args.ref as string | undefined
    const path = args.path as string | undefined

    const flags = ['diff']
    if (staged) flags.push('--staged')
    if (ref) flags.push(ref)
    if (path) flags.push('--', path)

    return runGit(flags, getCwd())
  },
}

export const gitLogTool: Tool = {
  name: 'git_log',
  description: 'Show recent commit history.',
  parameters: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description: 'Number of commits to show (default 10)',
      },
      oneline: {
        type: 'boolean',
        description: 'Use one-line format (default true)',
      },
      ref: {
        type: 'string',
        description: 'Branch, tag, or ref to show log for',
      },
      path: {
        type: 'string',
        description: 'Limit log to commits affecting this file or directory',
      },
    },
  },
  async execute(args): Promise<ToolResult>
  {
    const count = (args.count as number) ?? 10
    const oneline = (args.oneline as boolean) ?? true
    const ref = args.ref as string | undefined
    const path = args.path as string | undefined

    const flags = ['log', `-n`, String(count)]
    if (oneline)
    {
      flags.push('--oneline')
    }
    else
    {
      flags.push('--pretty=format:%h %s (%an, %ar)')
    }

    if (ref) flags.push(ref)
    if (path) flags.push('--', path)

    return runGit(flags, getCwd())
  },
}
