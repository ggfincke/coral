#!/usr/bin/env node
// src/cli/main.tsx
// dispatch interactive and noninteractive Coral commands

if (process.argv[2] === 'exec')
{
  const { runExecCli } = await import('./exec.js')
  process.exitCode = await runExecCli(process.argv.slice(3))
}
else
{
  const { runInteractiveCli } = await import('./interactive.js')
  await runInteractiveCli(process.argv)
}
