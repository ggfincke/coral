// tests/tui/project-file-catalog.test.ts
// major project-file snapshot, refresh, isolation, & stale-work contracts

import { strict as assert } from 'node:assert'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as waitForImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import {
  ProjectFileCatalog,
  StaleProjectFileCatalogRequestError,
} from '../../src/tui/session/project-file-catalog.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

interface PendingCollection
{
  cwd: string
  resolve: (paths: string[]) => void
}

interface AbortableCollection
{
  signal: AbortSignal
  finishCleanup: () => void
}

test('project-file catalogs refresh stable session-owned snapshots & reject stale work', async () =>
{
  const cwd = await tempDir('coral-file-catalog-')
  const originalPath = join(cwd, 'original.ts')
  const createdPath = join(cwd, 'created.ts')
  await writeFile(originalPath, 'export const original = true\n', 'utf-8')

  const firstSession = new ProjectFileCatalog()
  const originalSnapshot = await firstSession.list(cwd)
  assert.ok(originalSnapshot.includes('original.ts'))
  assert.equal(Object.isFrozen(originalSnapshot), true)

  await writeFile(createdPath, 'export const created = true\n', 'utf-8')
  await unlink(originalPath)

  const stableSnapshot = await firstSession.list(cwd)
  assert.equal(stableSnapshot, originalSnapshot)
  assert.ok(stableSnapshot.includes('original.ts'))
  assert.ok(!stableSnapshot.includes('created.ts'))

  const secondSession = new ProjectFileCatalog()
  const independentSnapshot = await secondSession.list(cwd)
  assert.ok(independentSnapshot.includes('created.ts'))
  assert.ok(!independentSnapshot.includes('original.ts'))

  const refreshedSnapshot = await firstSession.refresh(cwd)
  assert.notEqual(refreshedSnapshot, originalSnapshot)
  assert.ok(refreshedSnapshot.includes('created.ts'))
  assert.ok(!refreshedSnapshot.includes('original.ts'))

  const pending: PendingCollection[] = []
  const deferredCatalog = new ProjectFileCatalog(
    (requestedCwd) =>
      new Promise<string[]>((resolve) =>
      {
        pending.push({ cwd: requestedCwd, resolve })
      })
  )
  const oldCwd = join(cwd, 'old')
  const newCwd = join(cwd, 'new')
  const oldRequest = deferredCatalog.refresh(oldCwd)
  const staleResult = assert.rejects(
    oldRequest,
    StaleProjectFileCatalogRequestError
  )

  deferredCatalog.invalidate()
  const newRequest = deferredCatalog.refresh(newCwd)
  assert.deepEqual(
    pending.map((entry) => entry.cwd),
    [oldCwd, newCwd]
  )

  pending[0]!.resolve(['stale.ts'])
  pending[1]!.resolve(['current.ts'])
  await staleResult
  assert.deepEqual(await newRequest, ['current.ts'])
  assert.deepEqual(await deferredCatalog.list(newCwd), ['current.ts'])

  const oldReload = deferredCatalog.list(oldCwd)
  assert.deepEqual(
    pending.map((entry) => entry.cwd),
    [oldCwd, newCwd, oldCwd]
  )
  pending[2]!.resolve(['fresh-old.ts'])
  assert.deepEqual(await oldReload, ['fresh-old.ts'])
})

test('project-file catalogs abort superseded generations & join disposal', async () =>
{
  const collections: AbortableCollection[] = []
  const catalog = new ProjectFileCatalog((_cwd, signal) =>
  {
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) =>
    {
      finishCleanup = resolve
    })
    collections.push({ signal, finishCleanup })

    return new Promise<string[]>((_resolve, reject) =>
    {
      signal.addEventListener(
        'abort',
        () =>
        {
          void cleanup.then(() => reject(signal.reason))
        },
        { once: true }
      )
    })
  })

  const first = catalog.list('/first')
  const firstStale = assert.rejects(first, StaleProjectFileCatalogRequestError)
  const replacement = catalog.refresh('/first')
  assert.equal(collections.length, 2)
  assert.equal(collections[0]!.signal.aborted, true)
  await firstStale

  const replacementStale = assert.rejects(
    replacement,
    StaleProjectFileCatalogRequestError
  )
  let disposalSettled = false
  const disposal = catalog.dispose().then(() =>
  {
    disposalSettled = true
  })
  assert.equal(collections[1]!.signal.aborted, true)
  await replacementStale

  collections[0]!.finishCleanup()
  await waitForImmediate()
  assert.equal(disposalSettled, false)

  collections[1]!.finishCleanup()
  await disposal
  assert.equal(disposalSettled, true)
  await assert.rejects(
    catalog.list('/after-dispose'),
    StaleProjectFileCatalogRequestError
  )
  assert.equal(collections.length, 2)
})
