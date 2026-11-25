// src/tools/ripgrep-utils.ts
// shared ripgrep execution and error handling

import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { ToolResult } from './tool.js'
import { getCwd } from '../cwd.js'
import { checkWorkspacePath } from '../shared/workspace-path.js'
import { formatProjectPath } from '../shared/project-tree.js'
import { isPathInsideProject } from '../utils/path-containment.js'
import { BoundedOutput, childProcessEnv } from '../utils/process.js'
import { toErrorMessage } from '../utils/errors.js'
import { ItemPage } from '../utils/truncate-output.js'

interface RgSearchTarget
{
  searchPath: string
  cwd: string
  isProjectPath: boolean
  error?: string
}

// resolve raw tool path into rg searchPath + optional project cwd
export async function resolveRgSearchTarget(
  rawPath?: string,
  cwd = getCwd(),
  allowOutsideWorkspace = false
): Promise<RgSearchTarget>
{
  const allowed = await checkWorkspacePath(cwd, rawPath, allowOutsideWorkspace)
  if (!allowed.ok)
  {
    return {
      searchPath: allowed.path,
      cwd,
      isProjectPath: false,
      error: allowed.error,
    }
  }

  const path = allowed.path
  const isProjectPath = isPathInsideProject(cwd, path)
  const projectPath = isProjectPath ? formatProjectPath(cwd, path) : path
  // callers also pass '--' before the path; the ./ prefix keeps a dash-led
  // name from reading as an rg flag even if that separator is ever dropped
  const searchPath = projectPath.startsWith('-')
    ? `./${projectPath}`
    : projectPath
  return { searchPath, cwd, isProjectPath }
}

// keep rg out of git internals since --hidden would otherwise include them;
// callers add it after any user glob because a later rg glob wins
export const RG_EXCLUDE_GIT_DIR = ['--glob', '!.git'] as const

const RG_TIMEOUT = 15_000
// retained match text; a run past it keeps counting but stops buffering
const RG_MAX_RETAINED_CHARS = 5 * 1024 * 1024
const RG_MAX_STDERR_CHARS = 64 * 1024

// no-match sentinels for caller comparisons
export const NO_MATCHES_MESSAGE = 'No matches found.'
export const NO_MATCHING_FILES_MESSAGE = 'No matching files found.'

interface RipgrepOptions
{
  cwd?: string
  // abort kills the rg child so a cancelled run doesn't keep scanning
  signal?: AbortSignal
  // output lines shown before the Showing-N-of-M note
  maxItems: number
  // what those lines are called in the note
  label: string
}

interface RipgrepRun
{
  code: number | null
  stderr: string
  timedOut: boolean
  error?: NodeJS.ErrnoException
}

// stream rg stdout into the page so memory holds only what is shown
function runRipgrep(
  args: string[],
  page: ItemPage,
  options: RipgrepOptions
): Promise<RipgrepRun>
{
  return new Promise((resolve) =>
  {
    const stderr = new BoundedOutput(RG_MAX_STDERR_CHARS)
    let timedOut = false
    let child: ChildProcess
    try
    {
      child = spawn('rg', args, {
        cwd: options.cwd,
        env: childProcessEnv(),
        signal: options.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }
    catch (error)
    {
      resolve({ code: null, stderr: '', timedOut, error: error as Error })
      return
    }
    const timer = setTimeout(() =>
    {
      timedOut = true
      child.kill()
    }, RG_TIMEOUT)
    const decoder = new StringDecoder('utf8')
    child.stdout!.on('data', (chunk: Buffer) =>
      page.append(decoder.write(chunk))
    )
    const flushStderr = stderr.capture(child.stderr!)
    let settled = false
    const settle = (code: number | null, error?: NodeJS.ErrnoException) =>
    {
      if (settled) return
      settled = true
      clearTimeout(timer)
      page.append(decoder.end())
      flushStderr()
      resolve({ code, stderr: stderr.toString(), timedOut, error })
    }
    child.once('error', (error) => settle(null, error))
    child.once('close', (code) => settle(code))
  })
}

// execute ripgrep with shared error handling and a streamed item page
export async function execRipgrep(
  args: string[],
  noMatchMessage: string,
  options: RipgrepOptions
): Promise<ToolResult>
{
  const page = new ItemPage(
    options.maxItems,
    options.label,
    RG_MAX_RETAINED_CHARS
  )
  const run = await runRipgrep(args, page, options)

  if (run.error?.code === 'ENOENT')
  {
    return {
      output: '',
      error:
        'ripgrep (rg) is not installed. Install it: https://github.com/BurntSushi/ripgrep#installation',
    }
  }
  if (run.error) return { output: '', error: toErrorMessage(run.error) }
  if (run.timedOut)
  {
    return { output: '', error: `rg timed out after ${RG_TIMEOUT} ms` }
  }

  // exit code 1 = no matches
  if (run.code === 1) return { output: noMatchMessage }

  // exit code 2 = pattern/config error, other codes = signal/etc
  if (run.code !== 0)
  {
    return {
      output: '',
      error: run.stderr.trim() || `rg exited with code ${String(run.code)}`,
    }
  }

  return { output: page.finish() }
}
