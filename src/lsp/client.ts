// src/lsp/client.ts
// lazy Agent-owned TypeScript language-server client

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CancellationTokenSource,
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import { readRequiredTextFile } from '../utils/file-read.js'
import { isPlainObject } from '../utils/guards.js'
import { toErrorMessage } from '../utils/errors.js'
import {
  formatDiagnostics,
  formatHoverResult,
  formatLocationResult,
  type LspDiagnostic,
} from './format.js'

const require = createRequire(import.meta.url)
const STARTUP_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
const DIAGNOSTICS_TIMEOUT_MS = 5_000
const DIAGNOSTICS_DEBOUNCE_MS = 150
const SHUTDOWN_TIMEOUT_MS = 2_000
const PROCESS_EXIT_TIMEOUT_MS = 500
const MAX_STDERR_CHARS = 8_000
const MAX_START_ATTEMPTS = 2

const LANGUAGE_IDS = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'typescriptreact'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascriptreact'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
])

export type CodeIntelOperation =
  'definition' | 'references' | 'hover' | 'diagnostics'

export interface CodeIntelQuery
{
  operation: CodeIntelOperation
  path: string
  line?: number
  character?: number
  signal?: AbortSignal
}

export interface CodeIntelService
{
  query(request: CodeIntelQuery): Promise<string>
  dispose(): Promise<void>
}

interface OpenDocument
{
  version: number
  content: string
}

interface SyncedDocument
{
  uri: string
  changed: boolean
}

interface DiagnosticParams
{
  uri: string
  diagnostics: LspDiagnostic[]
}

interface DiagnosticWaiter
{
  promise: Promise<void>
  cancel: () => void
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void>
{
  return new Promise((resolvePromise, reject) =>
  {
    const cleanup = () =>
    {
      child.off('spawn', onSpawn)
      child.off('error', onError)
    }
    const onSpawn = () =>
    {
      cleanup()
      resolvePromise()
    }
    const onError = (error: Error) =>
    {
      cleanup()
      reject(error)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

async function controlledRequest<T>(
  run: (source: CancellationTokenSource) => Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<T>
{
  if (signal?.aborted)
  {
    throw new DOMException('Aborted', 'AbortError')
  }

  const source = new CancellationTokenSource()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined

  const control = new Promise<never>((_resolve, reject) =>
  {
    timeout = setTimeout(() =>
    {
      source.cancel()
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    if (signal)
    {
      onAbort = () =>
      {
        source.cancel()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })

  try
  {
    return await Promise.race([run(source), control])
  }
  finally
  {
    if (timeout) clearTimeout(timeout)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    source.dispose()
  }
}

function asDiagnosticParams(value: unknown): DiagnosticParams | null
{
  if (!isPlainObject(value)) return null
  if (typeof value.uri !== 'string') return null
  if (!Array.isArray(value.diagnostics)) return null
  return {
    uri: value.uri,
    diagnostics: value.diagnostics.filter(isPlainObject) as LspDiagnostic[],
  }
}

function languageId(path: string): string | null
{
  return LANGUAGE_IDS.get(extname(path).toLowerCase()) ?? null
}

export function isCodeIntelPath(path: string): boolean
{
  return languageId(path) !== null
}

// * Own one TypeScript language server for an interactive Agent & its subagents
export class TypeScriptCodeIntel implements CodeIntelService
{
  private child?: ChildProcessWithoutNullStreams
  private connection?: MessageConnection
  private startPromise?: Promise<void>
  private started = false
  private disposed = false
  private stopping = false
  private startAttempts = 0
  private lastError?: Error
  private stderrTail = ''
  private documents = new Map<string, OpenDocument>()
  private diagnostics = new Map<string, LspDiagnostic[]>()
  private diagnosticListeners = new Map<string, Set<() => void>>()

  constructor(private cwd: string)
  {
    this.cwd = resolve(cwd)
  }

  private rememberStderr(chunk: Buffer): void
  {
    this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(
      -MAX_STDERR_CHARS
    )
  }

  private serverError(message: string): Error
  {
    const detail = this.stderrTail.trim()
    return new Error(detail ? `${message}: ${detail}` : message)
  }

  private markStopped(error?: Error): void
  {
    this.started = false
    this.documents.clear()
    this.diagnostics.clear()
    if (error) this.lastError = error
  }

  private handleUnexpectedExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void
  {
    if (this.child !== child) return
    this.connection?.dispose()
    this.connection = undefined
    this.child = undefined
    if (this.stopping || this.disposed)
    {
      this.markStopped()
      return
    }

    const reason =
      code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`
    this.markStopped(
      this.serverError(`TypeScript language server exited with ${reason}`)
    )
  }

  private handleUnexpectedClose(): void
  {
    if (this.stopping || this.disposed) return
    const error =
      this.lastError ??
      new Error('TypeScript language server connection closed unexpectedly')
    const child = this.child
    this.connection = undefined
    this.child = undefined
    this.markStopped(error)
    child?.kill('SIGTERM')
  }

  private registerServerHandlers(connection: MessageConnection): void
  {
    connection.onNotification('textDocument/publishDiagnostics', (value) =>
    {
      const params = asDiagnosticParams(value)
      if (!params) return
      this.diagnostics.set(params.uri, params.diagnostics)
      for (const listener of this.diagnosticListeners.get(params.uri) ?? [])
      {
        listener()
      }
    })

    connection.onRequest('window/workDoneProgress/create', () => null)
    connection.onRequest('client/registerCapability', () => null)
    connection.onRequest('client/unregisterCapability', () => null)
    connection.onRequest('workspace/workspaceFolders', () => [
      { name: basename(this.cwd), uri: pathToFileURL(this.cwd).href },
    ])
    connection.onRequest('workspace/configuration', (value: unknown) =>
    {
      const items =
        isPlainObject(value) && Array.isArray(value.items) ? value.items : []
      return items.map(() => null)
    })
    connection.onRequest('workspace/applyEdit', () => ({
      applied: false,
      failureReason: 'Coral code intelligence is read-only',
    }))
    connection.onRequest('window/showDocument', () => ({ success: false }))
  }

  private async start(signal?: AbortSignal): Promise<void>
  {
    if (this.disposed) throw new Error('Code intelligence is already shut down')
    if (this.startAttempts >= MAX_START_ATTEMPTS)
    {
      throw (
        this.lastError ?? new Error('TypeScript language server is unavailable')
      )
    }
    this.startAttempts++
    this.stderrTail = ''

    const serverPackage =
      require.resolve('typescript-language-server/package.json')
    const serverCli = join(dirname(serverPackage), 'lib', 'cli.mjs')
    const tsserver = require.resolve('typescript/lib/tsserver.js')
    const child = spawn(
      process.execPath,
      [serverCli, '--stdio', '--log-level', '1'],
      {
        cwd: this.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }
    )
    this.child = child
    child.stderr.on('data', (chunk: Buffer) => this.rememberStderr(chunk))
    child.stdin.on('error', () => undefined)
    child.on('error', (error) =>
    {
      if (!this.stopping) this.lastError = error
    })
    child.on('exit', (code, exitSignal) =>
      this.handleUnexpectedExit(child, code, exitSignal)
    )

    try
    {
      await controlledRequest(
        () => waitForSpawn(child),
        STARTUP_TIMEOUT_MS,
        'TypeScript language server startup',
        signal
      )

      const connection = createMessageConnection(
        new StreamMessageReader(child.stdout),
        new StreamMessageWriter(child.stdin)
      )
      this.connection = connection
      this.registerServerHandlers(connection)
      connection.onError(([error]) =>
      {
        if (!this.stopping) this.lastError = error
      })
      connection.onClose(() =>
      {
        this.handleUnexpectedClose()
      })
      connection.listen()

      await controlledRequest(
        (source) =>
          connection.sendRequest(
            'initialize',
            {
              processId: process.pid,
              rootPath: this.cwd,
              rootUri: pathToFileURL(this.cwd).href,
              workspaceFolders: [
                { name: basename(this.cwd), uri: pathToFileURL(this.cwd).href },
              ],
              initializationOptions: { tsserver: { path: tsserver } },
              capabilities: {
                workspace: { configuration: true, workspaceFolders: true },
                textDocument: {
                  synchronization: {
                    dynamicRegistration: false,
                    didSave: true,
                  },
                  definition: { dynamicRegistration: false, linkSupport: true },
                  references: { dynamicRegistration: false },
                  hover: {
                    dynamicRegistration: false,
                    contentFormat: ['markdown', 'plaintext'],
                  },
                  publishDiagnostics: {
                    relatedInformation: true,
                    versionSupport: true,
                  },
                },
                general: { positionEncodings: ['utf-16'] },
              },
            },
            source.token
          ),
        STARTUP_TIMEOUT_MS,
        'TypeScript language server initialization',
        signal
      )
      await connection.sendNotification('initialized', {})
      this.started = true
      this.lastError = undefined
    }
    catch (error)
    {
      this.lastError = this.serverError(
        `Failed to start TypeScript language server: ${toErrorMessage(error)}`
      )
      await this.stopProcess()
      throw this.lastError
    }
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void>
  {
    if (this.started && this.connection) return
    this.startPromise ??= this.start(signal).finally(() =>
    {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  private async syncDocument(
    path: string,
    signal?: AbortSignal
  ): Promise<SyncedDocument>
  {
    const id = languageId(path)
    if (!id)
    {
      throw new Error(
        `Unsupported code-intelligence file type: ${extname(path) || '(none)'}`
      )
    }

    const file = await readRequiredTextFile(path)
    if (!file.ok) throw new Error(file.message)
    await this.ensureStarted(signal)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const connection = this.connection
    if (!connection)
      throw new Error('TypeScript language server is unavailable')
    const uri = pathToFileURL(path).href
    const current = this.documents.get(path)

    if (!current)
    {
      this.documents.set(path, { version: 1, content: file.content })
      await connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: id,
          version: 1,
          text: file.content,
        },
      })
      return { uri, changed: true }
    }

    if (current.content !== file.content)
    {
      const next = current.version + 1
      this.documents.set(path, { version: next, content: file.content })
      await connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: next },
        contentChanges: [{ text: file.content }],
      })
      return { uri, changed: true }
    }
    return { uri, changed: false }
  }

  private sendRequest<T>(
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<T>
  {
    const connection = this.connection
    if (!connection)
      throw new Error('TypeScript language server is unavailable')
    return controlledRequest(
      (source) => connection.sendRequest<T>(method, params, source.token),
      REQUEST_TIMEOUT_MS,
      `Code intelligence ${method}`,
      signal
    )
  }

  private createDiagnosticWaiter(
    uri: string,
    signal?: AbortSignal
  ): DiagnosticWaiter
  {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let debounce: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    let settled = false
    let rejectPromise: (error: Error) => void = () => undefined
    let resolvePromise: () => void = () => undefined

    const cleanup = () =>
    {
      if (timeout) clearTimeout(timeout)
      if (debounce) clearTimeout(debounce)
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      const listeners = this.diagnosticListeners.get(uri)
      listeners?.delete(onDiagnostic)
      if (listeners?.size === 0) this.diagnosticListeners.delete(uri)
    }
    const settle = (error?: Error) =>
    {
      if (settled) return
      settled = true
      cleanup()
      if (error) rejectPromise(error)
      else resolvePromise()
    }
    const onDiagnostic = () =>
    {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => settle(), DIAGNOSTICS_DEBOUNCE_MS)
    }
    const promise = new Promise<void>((resolveWait, rejectWait) =>
    {
      resolvePromise = resolveWait
      rejectPromise = rejectWait
      timeout = setTimeout(
        () =>
          settle(
            new Error(
              `TypeScript diagnostics were not published within ${DIAGNOSTICS_TIMEOUT_MS}ms; run the project typecheck as a fallback`
            )
          ),
        DIAGNOSTICS_TIMEOUT_MS
      )
      if (signal)
      {
        onAbort = () => settle(new DOMException('Aborted', 'AbortError'))
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })

    const listeners = this.diagnosticListeners.get(uri) ?? new Set()
    listeners.add(onDiagnostic)
    this.diagnosticListeners.set(uri, listeners)
    return { promise, cancel: () => settle() }
  }

  private async queryDiagnostics(
    path: string,
    signal?: AbortSignal
  ): Promise<string>
  {
    await this.ensureStarted(signal)
    const uri = pathToFileURL(path).href
    const hadCachedDiagnostics = this.diagnostics.has(uri)
    const cachedDiagnostics = this.diagnostics.get(uri) ?? []
    this.diagnostics.delete(uri)
    const waiter = this.createDiagnosticWaiter(uri, signal)

    try
    {
      const synced = await this.syncDocument(path, signal)
      if (!synced.changed && hadCachedDiagnostics)
      {
        waiter.cancel()
        this.diagnostics.set(uri, cachedDiagnostics)
        return formatDiagnostics(cachedDiagnostics, this.cwd, path)
      }
      if (!synced.changed)
      {
        const connection = this.connection
        if (!connection)
        {
          throw new Error('TypeScript language server is unavailable')
        }
        await connection.sendNotification('textDocument/didClose', {
          textDocument: { uri },
        })
        this.documents.delete(path)
        await this.syncDocument(path, signal)
      }
      await waiter.promise
      return formatDiagnostics(this.diagnostics.get(uri) ?? [], this.cwd, path)
    }
    catch (error)
    {
      waiter.cancel()
      throw error
    }
  }

  async query(request: CodeIntelQuery): Promise<string>
  {
    const path = resolve(this.cwd, request.path)
    if (request.operation === 'diagnostics')
    {
      return this.queryDiagnostics(path, request.signal)
    }

    const line = request.line
    const character = request.character
    if (
      !Number.isInteger(line) ||
      !Number.isInteger(character) ||
      line! < 1 ||
      character! < 1
    )
    {
      throw new Error(
        `${request.operation} requires integer line and character values`
      )
    }

    const { uri } = await this.syncDocument(path, request.signal)
    const params = {
      textDocument: { uri },
      position: { line: line! - 1, character: character! - 1 },
    }

    if (request.operation === 'definition')
    {
      const result = await this.sendRequest<unknown>(
        'textDocument/definition',
        params,
        request.signal
      )
      return formatLocationResult(result, this.cwd, 'definition')
    }
    if (request.operation === 'references')
    {
      const result = await this.sendRequest<unknown>(
        'textDocument/references',
        { ...params, context: { includeDeclaration: true } },
        request.signal
      )
      return formatLocationResult(result, this.cwd, 'references')
    }

    const result = await this.sendRequest<unknown>(
      'textDocument/hover',
      params,
      request.signal
    )
    return formatHoverResult(result)
  }

  private waitForExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number
  ): Promise<boolean>
  {
    if (child.exitCode !== null || child.signalCode !== null)
    {
      return Promise.resolve(true)
    }
    return new Promise((resolveWait) =>
    {
      const timeout = setTimeout(() =>
      {
        child.off('exit', onExit)
        resolveWait(false)
      }, timeoutMs)
      const onExit = () =>
      {
        clearTimeout(timeout)
        resolveWait(true)
      }
      child.once('exit', onExit)
    })
  }

  private async stopProcess(): Promise<void>
  {
    const connection = this.connection
    const child = this.child
    this.stopping = true

    try
    {
      if (connection && this.started)
      {
        try
        {
          await controlledRequest(
            (source) => connection.sendRequest('shutdown', {}, source.token),
            SHUTDOWN_TIMEOUT_MS,
            'TypeScript language server shutdown'
          )
          await connection.sendNotification('exit', {})
        }
        catch (error)
        {
          this.lastError ??= new Error(
            `TypeScript language server shutdown failed: ${toErrorMessage(error)}`
          )
        }
      }
      connection?.dispose()

      if (child && !(await this.waitForExit(child, PROCESS_EXIT_TIMEOUT_MS)))
      {
        child.kill('SIGTERM')
        if (!(await this.waitForExit(child, PROCESS_EXIT_TIMEOUT_MS)))
        {
          child.kill('SIGKILL')
        }
      }
    }
    finally
    {
      if (this.child === child) this.child = undefined
      if (this.connection === connection) this.connection = undefined
      this.markStopped()
      this.stopping = false
    }
  }

  async dispose(): Promise<void>
  {
    if (this.disposed) return
    this.disposed = true
    await this.startPromise?.catch(() => undefined)
    await this.stopProcess()
  }
}
