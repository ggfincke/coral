// tests/lsp/client.test.ts
// in-memory coverage for serialized language-server document transactions

import { strict as assert } from 'node:assert'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { TypeScriptCodeIntel } from '../../src/lsp/client.js'

function gate(): { promise: Promise<void>; release: () => void }
{
  let release!: () => void
  const promise = new Promise<void>((resolve) =>
  {
    release = resolve
  })
  return { promise, release }
}

test('LSP transactions refresh retained dependencies and join cancellation', async (t) =>
{
  const cwd = '/coral-in-memory-lsp'
  const dependency = join(cwd, 'dependency.ts')
  const importer = join(cwd, 'importer.ts')
  const dependencyUri = pathToFileURL(dependency).href
  const files = new Map<string, string | Error>([
    [dependency, 'export const value: number = 1\n'],
    [importer, 'import { value } from "./dependency"\n'],
  ])
  const reads: string[] = []
  const events: string[] = []
  const readGate = gate()
  const readEntered = gate()
  let holdRead = false
  let readSignal: AbortSignal | undefined
  const fileContent = (path: unknown): string =>
  {
    const content = files.get(String(path))
    if (content instanceof Error) throw content
    if (content === undefined)
      throw Object.assign(new Error('missing file'), { code: 'ENOENT' })
    return content
  }
  t.mock.method(fs, 'stat', (async (path: unknown) => ({
    size: Buffer.byteLength(fileContent(path)),
  })) as unknown as typeof fs.stat)
  t.mock.method(fs, 'readFile', (async (
    path: unknown,
    options: { signal?: AbortSignal }
  ) =>
  {
    reads.push(String(path))
    if (holdRead)
    {
      readSignal = options.signal
      readEntered.release()
      await readGate.promise
    }
    return fileContent(path)
  }) as unknown as typeof fs.readFile)
  syncBuiltinESMExports()

  const client = new TypeScriptCodeIntel(cwd)
  const internal = client as unknown as {
    start: (signal?: AbortSignal) => Promise<void>
    connection?: MessageConnection
    started: boolean
    startAttempts: number
    queryTail: Promise<void>
    documents: Map<string, { version: number; content?: string }>
    handleUnexpectedClose: (connection: MessageConnection) => void
  }
  let starts = 0
  let connectionDisposals = 0
  let changeGate: ReturnType<typeof gate> | undefined
  let changeEntered: ReturnType<typeof gate> | undefined
  let rejectChange = false
  t.mock.method(internal, 'start', async () =>
  {
    starts++
    const generation = starts
    const overlays = new Map<string, string>()
    internal.connection = {
      async sendNotification(method: string, params: unknown)
      {
        const notification = params as {
          textDocument?: { uri: string; text: string; version: number }
          contentChanges?: { text: string }[]
        }
        const document = notification.textDocument
        events.push(`${generation}:${method}`)
        if (method === 'textDocument/didChange')
        {
          changeEntered?.release()
          if (changeGate) await changeGate.promise
          if (rejectChange) throw new Error('notification failed')
          overlays.set(document!.uri, notification.contentChanges![0]!.text)
        }
        else if (method === 'textDocument/didOpen')
        {
          overlays.set(document!.uri, document!.text)
        }
        else if (method === 'textDocument/didClose')
        {
          overlays.delete(document!.uri)
        }
      },
      async sendRequest(method: string)
      {
        events.push(`${generation}:${method}`)
        if (method === 'workspace/executeCommand')
          return { success: true, body: [] }
        return { contents: overlays.get(dependencyUri) ?? 'missing dependency' }
      },
      dispose()
      {
        connectionDisposals++
      },
    } as unknown as MessageConnection
    internal.started = true
  })
  t.after(async () =>
  {
    changeGate?.release()
    readGate.release()
    await client.dispose()
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const hover = (path: string, signal?: AbortSignal) =>
    client.query({ operation: 'hover', path, line: 1, character: 1, signal })

  await assert.rejects(hover('missing.ts'), /missing file/)
  await assert.rejects(hover('unsupported.txt'), /Unsupported/)
  assert.equal(starts, 0)
  assert.match(await hover('dependency.ts'), /value: number/)
  files.set(dependency, 'export const value: string = "changed"\n')
  changeGate = gate()
  changeEntered = gate()
  const first = hover('importer.ts')
  await changeEntered.promise
  assert.equal(internal.documents.get(dependency)?.version, 1)
  const readsBeforeQueue = reads.length
  const canceled = new AbortController()
  const cancelledQuery = hover('cancelled.ts', canceled.signal)
  const cancelled = assert.rejects(cancelledQuery, { name: 'AbortError' })
  const second = client.query({ operation: 'diagnostics', path: 'importer.ts' })
  canceled.abort()
  await cancelled
  assert.equal(reads.length, readsBeforeQueue)
  assert.equal(events.includes('1:workspace/executeCommand'), false)
  changeGate.release()
  assert.match(await first, /value: string/)
  assert.equal(await second, 'No diagnostics reported for this file.')
  assert.equal(internal.documents.get(dependency)?.version, 2)
  assert.equal(starts, 1)
  assert.equal(
    reads.some((path) => basename(path) === 'cancelled.ts'),
    false
  )
  assert.ok(
    events.indexOf('1:textDocument/didChange') <
      events.indexOf('1:workspace/executeCommand')
  )
  changeGate = undefined
  changeEntered = undefined

  files.delete(dependency)
  const deletionStart = events.length
  assert.match(await hover('importer.ts'), /missing dependency/)
  assert.deepEqual(events.slice(deletionStart), [
    '1:textDocument/didClose',
    '1:textDocument/hover',
  ])
  assert.equal(internal.documents.has(dependency), false)

  files.set(dependency, 'export const value = 2\n')
  await hover('dependency.ts')
  files.set(
    dependency,
    Object.assign(new Error('unreadable'), { code: 'EACCES' })
  )
  const failureStart = events.length
  assert.match(await hover('importer.ts'), /missing dependency/)
  assert.deepEqual(events.slice(failureStart), [
    '1:textDocument/didClose',
    '1:textDocument/hover',
  ])
  assert.equal(internal.documents.has(dependency), false)

  files.set(dependency, 'export const value = 3\n')
  await hover('dependency.ts')
  const retired = internal.connection!
  files.set(dependency, 'export const value = 4\n')
  rejectChange = true
  await assert.rejects(hover('importer.ts'), /notification failed/)
  assert.equal(internal.documents.size, 0)
  assert.equal(internal.connection, undefined)
  assert.equal(connectionDisposals, 1)
  rejectChange = false
  assert.match(await hover('dependency.ts'), /value = 4/)
  assert.equal(internal.documents.get(dependency)?.version, 1)
  assert.equal(starts, 2)
  const current = internal.connection
  internal.handleUnexpectedClose(retired)
  assert.equal(internal.connection, current)

  // cancelled writes keep the server and resend full text on the next sync
  for (const value of [5, 6, 7])
  {
    files.set(dependency, `export const value = ${value}\n`)
    changeGate = gate()
    changeEntered = gate()
    const controller = new AbortController()
    const changing = hover('importer.ts', controller.signal)
    const cancelled = assert.rejects(changing, { name: 'AbortError' })
    await changeEntered.promise
    controller.abort()
    await cancelled
    await internal.queryTail
    assert.equal(internal.connection, current)
    assert.equal(internal.documents.get(dependency)?.content, undefined)
    assert.equal(internal.startAttempts, 2)
    changeGate.release()
    changeGate = undefined
    changeEntered = undefined
    assert.match(await hover('dependency.ts'), new RegExp(`value = ${value}`))
    assert.equal(
      internal.documents.get(dependency)?.content,
      `export const value = ${value}\n`
    )
  }
  assert.equal(starts, 2)

  holdRead = true
  const active = hover('importer.ts')
  await readEntered.promise
  const queued = hover('cancelled.ts')
  const activeAborted = assert.rejects(active, { name: 'AbortError' })
  const queuedAborted = assert.rejects(queued, { name: 'AbortError' })
  const disposal = client.dispose()
  assert.equal(client.dispose(), disposal)
  await Promise.all([activeAborted, queuedAborted])
  assert.equal(readSignal?.aborted, true)
  assert.equal(events.includes('2:shutdown'), false)
  readGate.release()
  await disposal
  assert.equal(connectionDisposals, 2)
  assert.equal(events.filter((event) => event === '2:shutdown').length, 1)
  assert.equal(internal.documents.size, 0)
  assert.deepEqual(new Set(reads), new Set([dependency, importer]))
  await assert.rejects(hover('dependency.ts'), { name: 'AbortError' })
})
