// src/agent/git-context.ts
// volatile git snapshot for model turns

import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { OllamaMessage } from '../types/inference.js'
import { runGitCommand, currentBranchLabel } from '../utils/git.js'

const MAX_FILES_PER_SECTION = 12
const MAX_STAT_LINES = 12
const MAX_RECENT_COMMITS = 5
const MAX_CONTEXT_CHARS = 6000

export const GIT_CONTEXT_HEADING = '## Git Context'

interface StatusGroups
{
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null>
{
  const result = await runGitCommand(args, cwd)
  if (result.error) return null
  return result.output
}

function parseStatus(output: string): StatusGroups
{
  const staged: string[] = []
  const unstaged: string[] = []
  const untracked: string[] = []

  for (const line of output.split('\n'))
  {
    if (!line) continue

    const code = line.slice(0, 2)
    const path = line.slice(3)

    if (code === '??')
    {
      untracked.push(path)
      continue
    }

    if (code[0] !== ' ') staged.push(path)
    if (code[1] !== ' ') unstaged.push(path)
  }

  return { staged, unstaged, untracked }
}

function formatLimitedList(label: string, values: string[]): string[]
{
  if (values.length === 0) return [`- ${label}: none`]

  const suffix =
    values.length > MAX_FILES_PER_SECTION
      ? `, showing first ${MAX_FILES_PER_SECTION}`
      : ''
  const lines = [`- ${label}: ${values.length}${suffix}`]

  for (const value of values.slice(0, MAX_FILES_PER_SECTION))
  {
    lines.push(`  - ${value}`)
  }

  return lines
}

function formatBlock(label: string, value: string | null): string[]
{
  if (!value?.trim()) return [`- ${label}: none`]

  const lines = value.trim().split('\n')
  const suffix =
    lines.length > MAX_STAT_LINES ? ` (showing first ${MAX_STAT_LINES})` : ''

  return [
    `- ${label}:${suffix}`,
    ...lines.slice(0, MAX_STAT_LINES).map((line) => `  ${line}`),
  ]
}

function summarizeGitError(error: string | undefined): string
{
  const firstLine = error?.trim().split('\n')[0] ?? ''
  const fallback = firstLine || 'git command failed'
  return fallback.length > 180 ? `${fallback.slice(0, 177)}...` : fallback
}

async function upstreamSummary(cwd: string): Promise<string>
{
  const upstream = await gitOutput(cwd, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ])

  if (!upstream?.trim()) return 'none'

  const counts = await gitOutput(cwd, [
    'rev-list',
    '--left-right',
    '--count',
    'HEAD...@{u}',
  ])
  const [ahead = '0', behind = '0'] = counts?.trim().split(/\s+/) ?? []

  return `${upstream.trim()} (${ahead} ahead, ${behind} behind)`
}

async function operationState(cwd: string): Promise<string>
{
  const checks: Array<[string, string]> = [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
  ]
  // resolve each marker against the git cwd, not process.cwd() — git prints
  // --git-path relative to the repo, so existsSync would otherwise look in the
  // wrong dir whenever getCwd() != the launch dir & report a false "none"
  const found = await Promise.all(
    checks.map(async ([gitPath, label]) =>
    {
      const path = await gitOutput(cwd, ['rev-parse', '--git-path', gitPath])
      return path && existsSync(resolve(cwd, path)) ? label : null
    })
  )

  const states = new Set(
    found.filter((label): label is string => label !== null)
  )

  return states.size > 0 ? [...states].join(', ') : 'none'
}

function truncateContext(content: string): string
{
  if (content.length <= MAX_CONTEXT_CHARS) return content

  const marker = '\n... (git context truncated)'
  return content.slice(0, MAX_CONTEXT_CHARS - marker.length) + marker
}

export async function buildGitContextMessage(
  cwd: string
): Promise<OllamaMessage | null>
{
  const root = await gitOutput(cwd, ['rev-parse', '--show-toplevel'])
  if (!root?.trim()) return null

  // independent reads — fan out so the snapshot costs one wave of git spawns
  // per request instead of a serial chain
  const [
    status,
    branch,
    upstream,
    operation,
    stagedStat,
    unstagedStat,
    recentCommits,
  ] = await Promise.all([
    runGitCommand(['status', '--porcelain=v1', '-uall'], cwd),
    currentBranchLabel(cwd),
    upstreamSummary(cwd),
    operationState(cwd),
    gitOutput(cwd, ['diff', '--staged', '--stat']),
    gitOutput(cwd, ['diff', '--stat']),
    gitOutput(cwd, ['log', '-n', String(MAX_RECENT_COMMITS), '--oneline']),
  ])

  const groups = status.error ? null : parseStatus(status.output)
  const dirtyCount = groups
    ? groups.staged.length + groups.unstaged.length + groups.untracked.length
    : 0
  const cwdFromRoot = relative(root, cwd) || '.'
  const statusLine = groups
    ? `- status: ${
        dirtyCount === 0 ? 'clean' : 'dirty'
      } (${groups.staged.length} staged, ${groups.unstaged.length} unstaged, ${
        groups.untracked.length
      } untracked)`
    : `- status: unknown (${summarizeGitError(status.error)})`
  const fileLines = groups
    ? [
        ...formatLimitedList('staged files', groups.staged),
        ...formatLimitedList('unstaged files', groups.unstaged),
        ...formatLimitedList('untracked files', groups.untracked),
      ]
    : [
        '- staged files: unknown',
        '- unstaged files: unknown',
        '- untracked files: unknown',
      ]

  const lines = [
    GIT_CONTEXT_HEADING,
    '',
    'Snapshot is current at request time; call git tools before staging, committing, switching branches, or pushing.',
    '',
    `- root: ${root}`,
    `- cwd: ${cwdFromRoot}`,
    `- branch: ${branch}`,
    `- upstream: ${upstream}`,
    `- operation: ${operation}`,
    statusLine,
    ...fileLines,
    ...formatBlock('staged diff stat', stagedStat),
    ...formatBlock('unstaged diff stat', unstagedStat),
    ...formatBlock('recent commits', recentCommits),
  ]

  return {
    role: 'system',
    content: truncateContext(lines.join('\n')),
  }
}
