// src/tools/git.ts
// git tools for status, diff, & log

import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import { getCwd } from '../cwd.js'
import {
  runGitCommand,
  currentBranchLabel,
  type GitCommandOptions,
} from '../utils/git.js'

// reject model-supplied refs that look like options — a ref like
// '--output=<path>' would let git write to an arbitrary file
function isUnsafeRef(ref: string): boolean
{
  return ref.startsWith('-')
}

// run a git command, applying a display placeholder when output is empty
async function runGit(
  args: string[],
  cwd: string,
  placeholder = '(no output)',
  options?: GitCommandOptions
): Promise<ToolResult>
{
  const result = await runGitCommand(args, cwd, options)
  if (result.error) return result
  return { output: result.output || placeholder }
}

export const gitStatusTool: Tool = {
  name: 'git_status',
  description:
    'Show the working tree status (staged, unstaged, & untracked files).',
  subagentSafe: true,
  parallelSafe: true,
  display: { label: 'Git Status', summarize: () => '' },
  parameters: {
    type: 'object',
    properties: {
      short: {
        type: 'boolean',
        description: 'Use short format output (default true)',
      },
    },
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const short = (args.short as boolean) ?? true
    const flags = short ? ['status', '--short'] : ['status']
    return runGit(flags, context?.cwd ?? getCwd())
  },
}

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description:
    'Show changes between commits, staging area, & working tree. On a large ' +
    'working tree, pass stat:true first for a per-file summary, then diff a ' +
    'specific path for detail.',
  subagentSafe: true,
  parallelSafe: true,
  display: {
    label: 'Git Diff',
    summarize: (args) =>
      [args.ref, args.path].filter(Boolean).map(String).join(' '),
  },
  parameters: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'Show staged (cached) changes instead of unstaged',
      },
      stat: {
        type: 'boolean',
        description:
          'Show a per-file summary (--stat) instead of the full diff body',
      },
      ref: {
        type: 'string',
        description:
          'Git ref or range to diff against (e.g., "HEAD~1", "main..HEAD")',
      },
      path: {
        type: 'string',
        description: 'Limit diff to a specific file or directory path',
      },
    },
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const staged = args.staged as boolean | undefined
    const stat = args.stat as boolean | undefined
    const ref = args.ref as string | undefined
    const path = args.path as string | undefined

    if (ref && isUnsafeRef(ref))
    {
      return { output: '', error: `Invalid ref: ${ref}` }
    }

    const flags = ['diff']
    if (stat) flags.push('--stat')
    if (staged) flags.push('--staged')
    if (ref) flags.push(ref)
    if (path) flags.push('--', path)

    // git diff can exit 1 w/ valid output in some configs — trust stdout here
    return runGit(flags, context?.cwd ?? getCwd(), '(no output)', {
      allowStdoutOnError: true,
    })
  },
}

export const gitLogTool: Tool = {
  name: 'git_log',
  description: 'Show recent commit history.',
  subagentSafe: true,
  parallelSafe: true,
  display: {
    label: 'Git Log',
    summarize: (args) =>
      [args.ref, args.path].filter(Boolean).map(String).join(' '),
  },
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
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const count = (args.count as number) ?? 10
    const oneline = (args.oneline as boolean) ?? true
    const ref = args.ref as string | undefined
    const path = args.path as string | undefined

    if (ref && isUnsafeRef(ref))
    {
      return { output: '', error: `Invalid ref: ${ref}` }
    }

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

    return runGit(flags, context?.cwd ?? getCwd())
  },
}

// approval-gated write tool — stages files for the next commit
export const gitAddTool: Tool = {
  name: 'git_add',
  description:
    'Stage files for commit. Pass specific paths, or all:true to stage every ' +
    'change (tracked & untracked).',
  display: {
    label: 'Git Add',
    summarize: (args) =>
    {
      if (args.all) return 'all'
      return Array.isArray(args.paths) ? args.paths.join(', ') : ''
    },
  },
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'File or directory paths to stage',
      },
      all: {
        type: 'boolean',
        description: 'Stage all changes instead of specific paths',
      },
    },
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const cwd = context?.cwd ?? getCwd()
    const all = args.all as boolean | undefined
    const paths = args.paths as string[] | undefined

    if (all)
    {
      const result = await runGitCommand(['add', '-A'], cwd)
      if (result.error) return result
      return { output: 'Staged all changes' }
    }

    if (!paths || paths.length === 0)
    {
      return { output: '', error: 'git_add requires paths or all:true' }
    }

    // reject option-like paths — '--' separates them from flags below
    const unsafe = paths.find(isUnsafeRef)
    if (unsafe)
    {
      return { output: '', error: `Invalid path: ${unsafe}` }
    }

    const result = await runGitCommand(['add', '--', ...paths], cwd)
    if (result.error) return result
    return { output: `Staged ${paths.length} path(s): ${paths.join(', ')}` }
  },
}

// approval-gated write tool — commits staged changes
export const gitCommitTool: Tool = {
  name: 'git_commit',
  description:
    'Create a commit from staged changes with the given message. Stage files ' +
    'with git_add first.',
  display: {
    label: 'Git Commit',
    summarize: (args) => String(args.message ?? ''),
  },
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Commit message',
      },
    },
    required: ['message'],
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const message = (args.message as string | undefined)?.trim()
    if (!message)
    {
      return { output: '', error: 'git_commit requires a non-empty message' }
    }

    return runGit(
      ['commit', '-m', message],
      context?.cwd ?? getCwd(),
      '(commit created)'
    )
  },
}

// approval-gated write tool — switches or creates branches
export const gitSwitchTool: Tool = {
  name: 'git_switch',
  description:
    'Switch branches. Pass create:true to create a new branch from HEAD, or ' +
    'with startPoint to create from a specific ref.',
  display: {
    label: 'Git Switch',
    summarize: (args) =>
    {
      const parts = [
        args.create ? '-c' : '',
        String(args.branch ?? ''),
        args.startPoint ? String(args.startPoint) : '',
      ].filter(Boolean)
      return parts.join(' ')
    },
  },
  parameters: {
    type: 'object',
    properties: {
      branch: {
        type: 'string',
        description: 'Branch name to switch to or create',
      },
      create: {
        type: 'boolean',
        description: 'Create the branch before switching (default false)',
      },
      startPoint: {
        type: 'string',
        description: 'Optional start ref when create:true',
      },
    },
    required: ['branch'],
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const branch = (args.branch as string | undefined)?.trim()
    const create = (args.create as boolean | undefined) ?? false
    const startPoint = (args.startPoint as string | undefined)?.trim()

    if (!branch)
    {
      return { output: '', error: 'git_switch requires a branch' }
    }
    if (isUnsafeRef(branch))
    {
      return { output: '', error: `Invalid branch: ${branch}` }
    }
    if (startPoint && isUnsafeRef(startPoint))
    {
      return { output: '', error: `Invalid startPoint: ${startPoint}` }
    }
    if (startPoint && !create)
    {
      return { output: '', error: 'git_switch startPoint requires create:true' }
    }

    const cwd = context?.cwd ?? getCwd()

    if (create)
    {
      const branchCheck = await runGitCommand(
        ['check-ref-format', '--branch', branch],
        cwd
      )
      if (branchCheck.error)
      {
        return { output: '', error: `Invalid branch: ${branch}` }
      }
    }

    const flags = ['switch']
    if (create) flags.push('-c')
    flags.push(branch)
    if (startPoint) flags.push(startPoint)

    const switched = await runGitCommand(flags, cwd)
    if (switched.error) return switched

    const currentBranch = await currentBranchLabel(cwd)
    const status = await runGitCommand(['status', '--short'], cwd)
    const statusBlock =
      !status.error && status.output.trim()
        ? `Status:\n${status.output}`
        : 'Status: clean'

    return {
      output: [`Current branch: ${currentBranch}`, statusBlock].join('\n'),
    }
  },
}

// approval-gated write tool — pushes commits to a remote
export const gitPushTool: Tool = {
  name: 'git_push',
  description:
    'Push committed changes to a remote. With no args, pushes the current ' +
    'branch to its upstream. For a branch with no upstream yet, pass remote, ' +
    'branch, & setUpstream:true.',
  display: {
    label: 'Git Push',
    summarize: (args) =>
      [args.remote, args.branch].filter(Boolean).map(String).join(' '),
  },
  parameters: {
    type: 'object',
    properties: {
      remote: {
        type: 'string',
        description:
          'Remote name (e.g. origin) — defaults to the branch upstream',
      },
      branch: {
        type: 'string',
        description: 'Branch to push — requires remote',
      },
      setUpstream: {
        type: 'boolean',
        description:
          'Set the upstream tracking ref (-u); requires remote & branch',
      },
    },
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const remote = args.remote as string | undefined
    const branch = args.branch as string | undefined
    const setUpstream = args.setUpstream as boolean | undefined

    if (remote && isUnsafeRef(remote))
    {
      return { output: '', error: `Invalid remote: ${remote}` }
    }
    if (branch && isUnsafeRef(branch))
    {
      return { output: '', error: `Invalid branch: ${branch}` }
    }
    if (branch && !remote)
    {
      return { output: '', error: 'git_push branch requires a remote' }
    }
    if (setUpstream && (!remote || !branch))
    {
      return {
        output: '',
        error: 'git_push setUpstream requires remote & branch',
      }
    }

    // --porcelain writes the push result to stdout; the human-readable summary
    // goes to stderr, which execFileSync drops on success
    const flags = ['push', '--porcelain']
    if (setUpstream) flags.push('-u')
    if (remote) flags.push(remote)
    if (branch) flags.push(branch)

    // pushes hit the network — allow more time than the default git timeout
    return runGit(flags, context?.cwd ?? getCwd(), '(pushed)', {
      timeout: 60_000,
    })
  },
}
