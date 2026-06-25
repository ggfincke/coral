// tests/helpers/git.ts
// git availability probe + repo-init fixture for node:test files

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

export const HAS_GIT = spawnSync('git', ['--version']).status === 0

// init a repo at dir w/ a test identity; returns a cwd-bound git runner.
// callers add their own files/commits (commit is intentionally not baked in)
export function initTestRepo(
  dir: string
): (...args: string[]) => SpawnSyncReturns<string>
{
  const run = (...args: string[]) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf-8' })

  run('init')
  run('config', 'user.email', 'test@coral.dev')
  run('config', 'user.name', 'Coral Test')

  return run
}
