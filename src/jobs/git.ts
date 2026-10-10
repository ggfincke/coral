// src/jobs/git.ts
// committed source selection and preserved task worktree identity

import { existsSync, rmSync } from 'node:fs'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileCommand, formatProcessError } from '../utils/process.js'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'
import { jobDirectory, writeJob } from './store.js'
import type { JobRecord, JobRepository } from './types.js'

const MAX_GIT_BYTES = 4 * 1024 * 1024
const MAX_DIFF_BYTES = 1024 * 1024
const GIT_OPTIONS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
]

async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal
): Promise<string>
{
  const result = await execFileCommand(
    'git',
    [...GIT_OPTIONS, '-C', cwd, ...args],
    {
      timeout: 60_000,
      maxBuffer: MAX_GIT_BYTES,
      signal,
    }
  )
  signal?.throwIfAborted()
  if (!result.ok)
    throw new Error(`Task Git operation failed: ${formatProcessError(result)}`)
  return result.stdout
}

function assertPlatform(): void
{
  if (process.platform !== 'darwin' && process.platform !== 'linux')
  {
    throw new Error('Durable tasks currently support macOS and Linux')
  }
}

export async function resolveJobRepository(
  cwd: string,
  ref?: string,
  signal?: AbortSignal
): Promise<JobRepository>
{
  assertPlatform()
  signal?.throwIfAborted()
  const source = await realpath(
    (await git(resolve(cwd), ['rev-parse', '--show-toplevel'], signal)).trim()
  )
  const commonDir = await realpath(
    (
      await git(
        source,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        signal
      )
    ).trim()
  )
  const dirty = await git(
    source,
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    signal
  )
  if (dirty.length > 0 && !ref)
  {
    throw new Error(
      'Source checkout has uncommitted or untracked files. Explicitly choose committed code with --ref HEAD (or another committed ref); those files will not be copied.'
    )
  }
  const commit = (
    await git(
      source,
      [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${ref ?? 'HEAD'}^{commit}`,
      ],
      signal
    )
  ).trim()
  return { source, commonDir, commit }
}

// a pending worktree was never verified or handed to the worker, so nothing
// in it is task work; clear any partial checkout & registration
async function discardPendingWorktree(
  source: string,
  path: string,
  signal?: AbortSignal
): Promise<void>
{
  const registered = (
    await git(source, ['worktree', 'list', '--porcelain', '-z'], signal)
  )
    .split('\0')
    .includes(`worktree ${path}`)
  // double force also removes a locked entry whose directory is gone
  if (registered)
    await git(
      source,
      ['worktree', 'remove', '--force', '--force', '--', path],
      signal
    )
  if (existsSync(path)) rmSync(path, { recursive: true, force: true })
}

// the persisted path is an intent record before any branch or checkout is
// created; it stays pending until the new worktree verifies
export async function ensureJobWorktree(
  job: JobRecord,
  signal?: AbortSignal
): Promise<JobRecord>
{
  assertPlatform()
  signal?.throwIfAborted()
  const directory = await realpath(jobDirectory(job.id))
  const path = join(directory, 'worktree')
  const branch = `codex/job-${job.id}`
  if (job.worktree)
  {
    if (job.worktree.path !== path || job.worktree.branch !== branch)
    {
      throw new Error(
        'Task worktree intent does not match its private owned location'
      )
    }
    if (!job.worktree.pending)
    {
      // a verified worktree may hold task work, so it is never rebuilt
      if (!existsSync(path))
      {
        throw new Error(
          `Task worktree is missing: ${path}. It held this task's changes on branch ${branch}; restore it or prepare a new task.`
        )
      }
      await assertJobWorktree(job, signal)
      return job
    }
  }
  const commonDir = await realpath(
    (
      await git(
        job.spec.repository.source,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        signal
      )
    ).trim()
  )
  if (commonDir !== job.spec.repository.commonDir)
  {
    throw new Error('Source repository identity changed after task approval')
  }
  const source = job.spec.repository.source
  if (job.worktree?.pending) await discardPendingWorktree(source, path, signal)
  job.worktree = { path, branch, pending: true }
  job.updatedAt = new Date().toISOString()
  writeJob(job)
  // an interrupted earlier attempt may have created the branch already; reuse
  // it only while it still names the approved commit
  const existing = (
    await git(
      source,
      ['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`],
      signal
    )
  ).trim()
  if (existing && existing !== job.spec.repository.commit)
  {
    throw new Error(
      `Branch ${branch} already exists at a different commit; inspect or delete it, then resume this task.`
    )
  }
  await git(
    source,
    [
      'worktree',
      'add',
      '--lock',
      '--reason',
      `Coral task ${job.id}`,
      ...(existing ? [] : ['-b', branch]),
      '--',
      path,
      existing ? branch : job.spec.repository.commit,
    ],
    signal
  )
  await assertJobWorktree(job, signal)
  delete job.worktree.pending
  job.updatedAt = new Date().toISOString()
  writeJob(job)
  return job
}

export async function assertJobWorktree(
  job: JobRecord,
  signal?: AbortSignal
): Promise<void>
{
  signal?.throwIfAborted()
  if (!job.worktree) throw new Error('Task has no worktree identity')
  const expected = join(await realpath(jobDirectory(job.id)), 'worktree')
  const path = await realpath(job.worktree.path)
  if (
    path !== expected ||
    job.worktree.path !== expected ||
    job.worktree.branch !== `codex/job-${job.id}` ||
    (await lstat(job.worktree.path)).isSymbolicLink()
  )
  {
    throw new Error('Task worktree location or branch identity changed')
  }
  const [topLevel, commonDir, head, branch, gitFile] = await Promise.all([
    git(path, ['rev-parse', '--show-toplevel'], signal),
    git(
      path,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      signal
    ),
    git(path, ['rev-parse', '--verify', 'HEAD'], signal),
    git(path, ['symbolic-ref', '--quiet', 'HEAD'], signal),
    lstat(join(path, '.git')),
  ])
  if (
    (await realpath(topLevel.trim())) !== expected ||
    (await realpath(commonDir.trim())) !== job.spec.repository.commonDir ||
    head.trim() !== job.spec.repository.commit ||
    branch.trim() !== `refs/heads/${job.worktree.branch}` ||
    !gitFile.isFile() ||
    gitFile.isSymbolicLink()
  )
  {
    throw new Error(
      'Task Git state changed: worktree, repository, branch, and original commit must remain intact'
    )
  }
  const entries = (
    await git(path, ['worktree', 'list', '--porcelain', '-z'], signal)
  ).split('\0\0')
  if (
    !entries.some(
      (entry) =>
        entry.split('\0').includes(`worktree ${expected}`) &&
        entry.split('\0').includes(`branch refs/heads/${job.worktree?.branch}`)
    )
  )
  {
    throw new Error(
      'Task worktree is no longer registered in its approved repository'
    )
  }
}

async function diffPart(
  cwd: string,
  args: string[],
  signal?: AbortSignal
): Promise<string>
{
  const result = await execFileCommand(
    'git',
    [
      ...GIT_OPTIONS,
      '-C',
      cwd,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      ...args,
      '--',
    ],
    {
      timeout: 30_000,
      maxBuffer: MAX_DIFF_BYTES,
      signal,
    }
  )
  signal?.throwIfAborted()
  if (!result.ok && result.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  {
    throw new Error(`Cannot read task diff: ${formatProcessError(result)}`)
  }
  return result.stdout + (result.ok ? '' : '\n[diff truncated]\n')
}

export async function getJobDiff(
  job: JobRecord,
  signal?: AbortSignal
): Promise<string>
{
  signal?.throwIfAborted()
  if (!job.worktree) return 'Task worktree has not been created.\n'
  await assertJobWorktree(job, signal)
  const path = job.worktree.path
  const parts = [
    'Staged changes\n',
    await diffPart(path, ['--cached', job.spec.repository.commit], signal),
    '\nUnstaged changes\n',
    await diffPart(path, [], signal),
    '\nUntracked files\n',
  ]
  let bytes = parts.reduce((total, part) => total + Buffer.byteLength(part), 0)
  const files = (
    await git(
      path,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      signal
    )
  )
    .split('\0')
    .filter(Boolean)
  for (const [index, file] of files.entries())
  {
    signal?.throwIfAborted()
    if (index >= 1000 || bytes >= MAX_DIFF_BYTES)
    {
      parts.push(
        `\n[${files.length - index} untracked files omitted; inspect the preserved worktree]\n`
      )
      break
    }
    const filePath = join(path, file)
    const info = await lstat(filePath)
    let content: string
    if (info.isSymbolicLink())
      content = `[symbolic link -> ${await readlink(filePath)}]`
    else if (!info.isFile()) content = '[non-regular file]'
    else if (info.size > 64 * 1024)
      content = `[file content omitted: ${info.size} bytes]`
    else
    {
      const buffer = await readFile(filePath)
      content = buffer.includes(0) ? '[binary file]' : buffer.toString('utf8')
    }
    const shown = `\n--- /dev/null\n+++ b/${file}\n${content}\n`
    parts.push(shown)
    bytes += Buffer.byteLength(shown)
  }
  const output = sanitizeUntrustedText(parts.join(''))
  return output.length > MAX_DIFF_BYTES
    ? output.slice(0, MAX_DIFF_BYTES) +
        '\n[diff truncated; inspect the preserved worktree]\n'
    : output
}

// planning reads the selected Git objects, never the caller's mutable checkout
export async function readJobSource(
  repository: JobRepository,
  file: string,
  signal?: AbortSignal
): Promise<string>
{
  if (
    !file ||
    file.startsWith('/') ||
    file.split('/').some((part) => part === '..') ||
    file.includes('\0')
  )
  {
    throw new Error(
      'Planning file paths must be relative to the selected committed tree'
    )
  }
  const result = await execFileCommand(
    'git',
    [
      ...GIT_OPTIONS,
      '-C',
      repository.source,
      'show',
      `${repository.commit}:${file}`,
    ],
    { maxBuffer: 64 * 1024, timeout: 30_000, signal }
  )
  signal?.throwIfAborted()
  if (!result.ok && result.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  {
    throw new Error(
      `Cannot read committed file ${file}: ${formatProcessError(result)}`
    )
  }
  return result.stdout.includes('\0')
    ? '[binary file]'
    : result.stdout + (result.ok ? '' : '\n[file truncated]')
}

export async function listJobSource(
  repository: JobRepository,
  signal?: AbortSignal
): Promise<string[]>
{
  return (
    await git(
      repository.source,
      ['ls-tree', '-r', '--name-only', '-z', repository.commit],
      signal
    )
  )
    .split('\0')
    .filter(Boolean)
}
