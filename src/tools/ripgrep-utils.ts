// src/tools/ripgrep-utils.ts
// shared ripgrep execution & error handling

import type { ToolResult } from './tool.js'
import { execFileCommand, formatProcessError } from '../utils/process.js'

const RG_TIMEOUT = 15_000
const RG_MAX_BUFFER = 5 * 1024 * 1024

// no-match sentinels — callers pass these in & compare output against them
export const NO_MATCHES_MESSAGE = 'No matches found.'
export const NO_MATCHING_FILES_MESSAGE = 'No matching files found.'

interface RipgrepOptions
{
  cwd?: string
  // abort kills the rg child so a cancelled run doesn't keep scanning
  signal?: AbortSignal
}

// execute ripgrep w/ shared error handling
export function execRipgrep(
  args: string[],
  noMatchMessage: string,
  options: RipgrepOptions = {}
): Promise<ToolResult>
{
  return execFileCommand('rg', args, {
    timeout: RG_TIMEOUT,
    maxBuffer: RG_MAX_BUFFER,
    cwd: options.cwd,
    signal: options.signal,
  }).then((result) =>
  {
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
  })
}
