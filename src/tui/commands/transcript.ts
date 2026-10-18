// src/tui/commands/transcript.ts
// register the transcript pager command while the app owns the overlay

import type { Command } from './contracts.js'
import { systemBlock } from './output.js'

export const transcriptCommand: Command = {
  name: 'transcript',
  description: 'Open the full-screen transcript pager (/ searches, q closes)',
  execute(_args, ctx)
  {
    ctx.pushOutput(
      systemBlock('Use /transcript or ctrl+l to open the transcript pager.')
    )
  },
}
