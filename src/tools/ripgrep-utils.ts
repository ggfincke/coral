// src/tools/ripgrep-utils.ts
// shared ripgrep execution and error handling

import type { ToolResult } from './tool.js'
import { getCwd } from '../cwd.js'
import { checkWorkspacePath } from '../shared/workspace-path.js'
import {
  formatProjectPath,
  isPathInsideProject,
} from '../shared/project-tree.js'
import { execFileCommand, formatProcessError } from '../utils/process.js'

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
  const searchPath = isProjectPath ? formatProjectPath(cwd, path) : path
  return { searchPath, cwd, isProjectPath }
}

const RG_TIMEOUT = 15_000
const RG_MAX_BUFFER = 5 * 1024 * 1024

// no-match sentinels for caller comparisons
export const NO_MATCHES_MESSAGE = 'No matches found.'
export const NO_MATCHING_FILES_MESSAGE = 'No matching files found.'

interface RipgrepOptions
{
  cwd?: string
  // abort kills the rg child so a cancelled run doesn't keep scanning
  signal?: AbortSignal
}

// execute ripgrep with shared error handling
export async function execRipgrep(
  args: string[],
  noMatchMessage: string,
  options: RipgrepOptions = {}
): Promise<ToolResult>
{
  const result = await execFileCommand('rg', args, {
    timeout: RG_TIMEOUT,
    maxBuffer: RG_MAX_BUFFER,
    cwd: options.cwd,
    signal: options.signal,
  })

  if (!result.ok && result.code === 'ENOENT')
  {
    return {
      output: '',
      error:
        'ripgrep (rg) is not installed. Install it: https://github.com/BurntSushi/ripgrep#installation',
    }
  }

  // exit code 1 = no matches
  if (!result.ok && result.code === 1)
  {
    return { output: noMatchMessage }
  }

  // exit code 2 = pattern/config error, other codes = timeout/signal/etc
  if (!result.ok)
  {
    return { output: '', error: formatProcessError(result) }
  }

  return { output: result.stdout }
}
