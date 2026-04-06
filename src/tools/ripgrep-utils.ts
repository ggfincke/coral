// src/tools/ripgrep-utils.ts
// shared ripgrep execution & error handling

import { execFile } from 'node:child_process'
import type { ToolResult } from './tool.js'

export const RG_TIMEOUT = 15_000
export const RG_MAX_BUFFER = 5 * 1024 * 1024

// execute ripgrep w/ shared error handling
export function execRipgrep(
  args: string[],
  noMatchMessage: string
): Promise<ToolResult>
{
  return new Promise((resolve) =>
  {
    execFile(
      'rg',
      args,
      { timeout: RG_TIMEOUT, maxBuffer: RG_MAX_BUFFER },
      (err, stdout, stderr) =>
      {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT')
        {
          resolve({
            output: '',
            error:
              'ripgrep (rg) is not installed. Install it: https://github.com/BurntSushi/ripgrep#installation',
          })
          return
        }

        // exit code 1 = no matches
        if (err && (err as { code?: number }).code === 1)
        {
          resolve({ output: noMatchMessage })
          return
        }

        // exit code 2 = pattern/config error, other codes = timeout/signal/etc
        if (err)
        {
          resolve({ output: '', error: stderr || err.message })
          return
        }

        resolve({ output: stdout })
      }
    )
  })
}
