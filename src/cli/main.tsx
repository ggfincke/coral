#!/usr/bin/env node
// src/cli/main.tsx
// dispatch parsed commands through separate lazy execution paths

import { parseCliArgs } from './args.js'

const parsed = parseCliArgs(process.argv.slice(2))
if (parsed.kind === 'exit') process.exitCode = parsed.code
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
