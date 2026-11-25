// src/tools/git.ts
// git status, diff, and log tools plus approval-gated add, commit, switch, and push

import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import { getCwd } from '../cwd.js'
import { checkWorkspacePath } from '../shared/workspace-path.js'
import { tryParseJson } from '../utils/json.js'
import {
  runGitCommand,
  currentBranchLabel,
  type GitCommandOptions,
} from '../utils/git.js'

// reject model-supplied refs that look like options because git could treat
// '--output=<path>' as an arbitrary file target
function isUnsafeRef(ref: string): boolean
{
  return ref.startsWith('-')
}

// pathspecs stay inside the workspace unless the path was approved; magic such
// as ':(top)' or ':/' would widen a pathspec past the launched directory
async function checkPathspec(
  path: string,
  cwd: string,
  context?: ToolExecutionContext
): Promise<string | undefined>
{
  if (path.startsWith(':'))
  {
    return `Pathspec magic is not supported: ${path}`
  }
  const allowed = await checkWorkspacePath(
    cwd,
    path,
    context?.allowOutsideWorkspace === true
  )
  return allowed.ok ? undefined : allowed.error
}

// refspec syntax that turns a branch push into a force (+), delete or rename
// (:), or a revision expression (^, ~, @{)
const UNSAFE_PUSH_BRANCH = /[+:^~]|@\{/

// a push target is HEAD or a branch name git accepts unchanged, so shorthand
// such as '@{-1}' that git expands is rejected
async function isPlainBranchName(
  branch: string,
  cwd: string,
  signal?: AbortSignal
): Promise<boolean>
{
  if (branch === 'HEAD') return true
  const check = await runGitCommand(
    ['check-ref-format', '--branch', branch],
    cwd,
    { signal }
  )
  return !check.error && check.output.trim() === branch
}

// a push remote must be one already configured, never a URL or local path
async function isConfiguredRemote(
  remote: string,
  cwd: string,
  signal?: AbortSignal
): Promise<boolean>
{
  const remotes = await runGitCommand(['remote'], cwd, { signal })
  if (remotes.error) return false
  return remotes.output.split('\n').some((name) => name.trim() === remote)
}

// remote names from '-z --get-regexp' entries whose value passes the test
async function remotesWhere(
  pattern: string,
  typeArgs: string[],
  matches: (value: string) => boolean,
  cwd: string,
  signal?: AbortSignal
): Promise<string[]>
{
  const config = await runGitCommand(
    ['config', '-z', ...typeArgs, '--get-regexp', pattern],
    cwd,
    { signal }
  )
  return config.output
    .split('\0')
    .map((entry) => entry.split('\n'))
    .filter(([, value]) => value !== undefined && matches(value))
    .map(([key = '']) => key.slice('remote.'.length, key.lastIndexOf('.')))
}

// remotes whose config forces or deletes on a plain push: mirror = true, or a
// push refspec led by '+' (force) or ':' (delete)
async function forcingRemotes(
  cwd: string,
  signal?: AbortSignal
): Promise<Set<string>>
{
  const [mirrors, refspecs] = await Promise.all([
    remotesWhere(
      '^remote\\..*\\.mirror$',
      ['--type=bool'],
      (value) => value === 'true',
      cwd,
      signal
    ),
    remotesWhere(
      '^remote\\..*\\.push$',
      [],
      (value) => /^\s*[+:]/.test(value),
      cwd,
      signal
    ),
  ])
  return new Set([...mirrors, ...refspecs])
}

// approved mutations run hooks (lint-staged, tsc, test suites) that can take
// minutes; they cannot be cancelled once started, so this is their only limit
const HOOK_GIT_TIMEOUT_MS = 5 * 60_000

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
    return runGit(flags, context?.cwd ?? getCwd(), '(no output)', {
      signal: context?.signal,
    })
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

    const cwd = context?.cwd ?? getCwd()
    const pathError = path ? await checkPathspec(path, cwd, context) : undefined
    if (pathError) return { output: '', error: pathError }

    const flags = ['diff']
    if (stat) flags.push('--stat')
    if (staged) flags.push('--staged')
    // '--' after the ref keeps git from reading it as a pathspec instead
    if (ref) flags.push(ref)
    flags.push('--')
    if (path) flags.push(path)

    // git diff can exit 1 with valid output in some configs, so trust stdout
    return runGit(flags, cwd, '(no output)', {
      allowStdoutOnError: true,
      signal: context?.signal,
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

    const cwd = context?.cwd ?? getCwd()
    const pathError = path ? await checkPathspec(path, cwd, context) : undefined
    if (pathError) return { output: '', error: pathError }

    const flags = ['log', `-n`, String(count)]
    if (oneline)
    {
      flags.push('--oneline')
    }
    else
    {
      flags.push('--pretty=format:%h %s (%an, %ar)')
    }

    // '--' after the ref keeps git from reading it as a pathspec instead
    if (ref) flags.push(ref)
    flags.push('--')
    if (path) flags.push(path)

    return runGit(flags, cwd, '(no output)', {
      signal: context?.signal,
    })
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
    // read all & paths the way validateToolArgs coerces them, so a
    // JSON-string array still shows every path that will be staged
    summarize: (args) =>
    {
      if (args.all === true || args.all === 'true') return 'all'
      const paths =
        typeof args.paths === 'string' ? tryParseJson(args.paths) : args.paths
      if (Array.isArray(paths)) return paths.map(String).join(', ')
      return typeof args.paths === 'string' ? args.paths : ''
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

    // reject option-like paths so the explicit '--' separator stays authoritative
    const unsafe = paths.find(isUnsafeRef)
    if (unsafe)
    {
      return { output: '', error: `Invalid path: ${unsafe}` }
    }
    for (const path of paths)
    {
      const pathError = await checkPathspec(path, cwd, context)
      if (pathError) return { output: '', error: pathError }
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
      '(commit created)',
      { timeout: HOOK_GIT_TIMEOUT_MS }
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
        cwd,
        { signal: context?.signal }
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

    // once started, a mutation and its report finish so success is never shown as a cancellation
    const switched = await runGitCommand(flags, cwd, {
      timeout: HOOK_GIT_TIMEOUT_MS,
    })
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
    if (branch && (isUnsafeRef(branch) || UNSAFE_PUSH_BRANCH.test(branch)))
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

    const cwd = context?.cwd ?? getCwd()
    if (remote && !(await isConfiguredRemote(remote, cwd, context?.signal)))
    {
      return { output: '', error: `Unknown remote: ${remote}` }
    }
    if (branch && !(await isPlainBranchName(branch, cwd, context?.signal)))
    {
      return { output: '', error: `Invalid branch: ${branch}` }
    }
    // w/o a remote git picks the default one, so any forcing remote refuses
    const forcing = await forcingRemotes(cwd, context?.signal)
    if (remote ? forcing.has(remote) : forcing.size > 0)
    {
      return {
        output: '',
        error: `Refusing to push to a mirror remote or one whose push refspec forces or deletes: ${[...forcing].join(', ')}`,
      }
    }

    // --porcelain writes the push result to stdout; the human-readable summary
    // goes to stderr, which runGitCommand drops on success
    const flags = ['push', '--porcelain']
    if (setUpstream) flags.push('-u')
    if (remote) flags.push(remote)
    if (branch) flags.push(branch)

    // pushes hit the network & run pre-push hooks
    return runGit(flags, cwd, '(pushed)', {
      timeout: HOOK_GIT_TIMEOUT_MS,
    })
  },
}
