#!/usr/bin/env node
// src/cli/main.tsx
// dispatch parsed commands through separate lazy execution paths

import { parseCliArgs } from './args.js'

// jobs owns its own Commander program, per-subcommand --cwd, and the internal
// supervisor/worker entrypoints, so it dispatches before shared parsing
if (process.argv[2] === 'jobs')
{
  const { runJobsCli } = await import('./jobs.js')
  process.exitCode = await runJobsCli(process.argv.slice(3))
}
else
{
  const parsed = parseCliArgs(process.argv.slice(2))
  if (parsed.kind === 'exit') process.exitCode = parsed.code
  else if (parsed.kind === 'skills')
  {
    const { runSkillsCli } = await import('./skills.js')
    process.exitCode = runSkillsCli(parsed.action, parsed.options)
  }
  else if (parsed.kind === 'acp')
  {
    const { runAcpCli } = await import('./acp.js')
    process.exitCode = await runAcpCli(parsed.options)
  }
  else if (parsed.kind === 'exec')
  {
    const { runExecCli } = await import('./exec.js')
    process.exitCode = await runExecCli(parsed.options)
  }
  else
  {
    const { runInteractiveCli } = await import('./interactive.js')
    await runInteractiveCli(parsed.options)
  }
}
