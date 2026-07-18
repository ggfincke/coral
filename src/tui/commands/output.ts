// src/tui/commands/output.ts
// shared slash-command output block and header primitives

import type { SessionSaveResult } from '../session/interactive-runtime.js'
import { style } from '../theme.js'
import type { SystemBlock } from '../transcript/types.js'

export function systemBlock(content: string): SystemBlock
{
  return { type: 'system', content }
}

export function committedSaveWarning(
  result: SessionSaveResult,
  subject: string
): SystemBlock | null
{
  if (result.status !== 'error' && result.status !== 'stale') return null
  return systemBlock(
    `${subject}, but the current session could not be saved. ` +
      'The change may not be available after exit.'
  )
}

export function coralHeader(title: string): string
{
  return `${style('primary')('Coral')} ${style('muted')(`— ${title}`)}`
}
