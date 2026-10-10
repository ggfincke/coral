// src/tui/commands/jobs.ts
// register durable task discovery while the app owns the interactive viewer

import type { Command } from './contracts.js'
import { systemBlock } from './output.js'

export const jobsCommand: Command = {
  name: 'jobs',
  description: 'Prepare, monitor, and review durable coding tasks',
  execute(_args, ctx)
  {
    ctx.pushOutput(
      systemBlock(
        'Use /jobs to open the task panel, or coral jobs --help for CLI controls.'
      )
    )
  },
}
