// tests/helpers/temp.ts
// shared temp-dir pool w/ auto-registered cleanup for node:test files

import { after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TempDirPool
{
  tempDir(prefix?: string): Promise<string>
  tempDirSync(prefix?: string): string
  cleanup(): Promise<void>
}

// pool of temp dirs; autoCleanup registers an after() that rm's them all.
// files w/ extra teardown (cwd/env/fetch) pass autoCleanup:false & call
// cleanup() last in their own after() to keep restore-before-rm ordering
export function makeTempDirPool(
  options: { autoCleanup?: boolean } = {}
): TempDirPool
{
  const { autoCleanup = true } = options
  const dirs: string[] = []

  const pool: TempDirPool = {
    async tempDir(prefix = 'coral-test-')
    {
      const dir = await mkdtemp(join(tmpdir(), prefix))
      dirs.push(dir)
      return dir
    },
    tempDirSync(prefix = 'coral-test-')
    {
      const dir = mkdtempSync(join(tmpdir(), prefix))
      dirs.push(dir)
      return dir
    },
    async cleanup()
    {
      await Promise.all(
        dirs.map((dir) => rm(dir, { recursive: true, force: true }))
      )
      dirs.length = 0
    },
  }

  if (autoCleanup)
  {
    after(() => pool.cleanup())
  }

  return pool
}
