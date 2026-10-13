// src/lsp/client.ts
// lazy TypeScript language-server client owned by Agent

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
import {
  readRequiredTextFile,
  type TextFileReadResult,
} from '../utils/file-read.js'
import { isPlainObject } from '../utils/guards.js'
import { toErrorMessage } from '../utils/errors.js'
import {
  formatDiagnostics,
  formatHoverResult,
  formatLocationResult,
  type LspDiagnostic,
} from './format.js'
import {
  codeIntelLanguageId,
  type CodeIntelQuery,
  type CodeIntelService,
} from './contracts.js'

const require = createRequire(import.meta.url)
const STARTUP_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
const DIAGNOSTICS_TIMEOUT_MS = 5_000
const SHUTDOWN_TIMEOUT_MS = 2_000
const PROCESS_EXIT_TIMEOUT_MS = 500
const MAX_STDERR_CHARS = 8_000
const MAX_START_ATTEMPTS = 2

// undefined content marks an interrupted write; the next sync resends full text
interface OpenDocument
{
  version: number
  content?: string
}

function isAbortError(error: unknown): boolean
{
  return (error as { name?: unknown } | null)?.name === 'AbortError'
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

// queued callers can cancel immediately while their transaction stays joined
async function waitForQuery<T>(
  work: Promise<T>,
  signal: AbortSignal
): Promise<T>
{
  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) =>
  {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try
  {
    return await Promise.race([work, aborted])
  }
  finally
  {
    signal.removeEventListener('abort', onAbort)
  }
}

function diagnosticResponse(value: unknown): LspDiagnostic[]
{
  if (
    !isPlainObject(value) ||
    value.success !== true ||
    !Array.isArray(value.body)
  )
  {
    throw new Error('TypeScript diagnostics returned an invalid response')
  }
  return value.body.map((item: unknown) =>
  {
    if (
      !isPlainObject(item) ||
      !isPlainObject(item.start) ||
      typeof item.start.line !== 'number' ||
      typeof item.start.offset !== 'number' ||
      typeof item.text !== 'string'
    )
    {
      throw new Error('TypeScript diagnostics returned an invalid diagnostic')
    }
    return {
      range: {
        start: {
          line: item.start.line - 1,
          character: item.start.offset - 1,
        },
      },
      severity:
        item.category === 'warning'
          ? 2
          : item.category === 'suggestion'
            ? 4
            : 1,
      code:
        typeof item.code === 'number' || typeof item.code === 'string'
          ? item.code
          : undefined,
      source: typeof item.source === 'string' ? item.source : 'typescript',
      message: item.text,
    }
  })
}

// * Own one TypeScript language server for an interactive Agent and its subagents
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
  private queryTail: Promise<void> = Promise.resolve()
  private lifetime = new AbortController()
  private disposePromise?: Promise<void>

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

  private handleUnexpectedClose(connection: MessageConnection): void
  {
    if (this.connection !== connection) return
    if (this.stopping || this.disposed) return
    const error =
      this.lastError ??
      new Error('TypeScript language server connection closed unexpectedly')
    const child = this.child
    this.connection = undefined
    this.child = undefined
    this.markStopped(error)
    connection.dispose()
    child?.kill('SIGTERM')
  }

  private registerServerHandlers(connection: MessageConnection): void
  {
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
        if (this.connection === connection && !this.stopping)
          this.lastError = error
      })
      connection.onClose(() =>
      {
        this.handleUnexpectedClose(connection)
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
      await controlledRequest(
        () => connection.sendNotification('initialized', {}),
        STARTUP_TIMEOUT_MS,
        'TypeScript language server initialization',
        signal
      )
      signal?.throwIfAborted()
      if (this.disposed || this.connection !== connection)
        throw new Error('TypeScript language server is unavailable')
      this.started = true
      this.lastError = undefined
    }
    catch (error)
    {
      // cancellation is not a server failure; keep the prior diagnostic
      if (signal?.aborted && isAbortError(error))
      {
        await this.stopProcess()
        throw error
      }
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
    if (!this.startPromise)
    {
      signal?.throwIfAborted()
      if (this.startAttempts >= MAX_START_ATTEMPTS)
      {
        throw (
          this.lastError ??
          new Error('TypeScript language server is unavailable')
        )
      }
      this.startAttempts++
      this.startPromise = this.start(signal)
        .catch((error) =>
        {
          // intentional cancellation must not consume the failure restart budget
          if (isAbortError(error)) this.startAttempts--
          throw error
        })
        .finally(() =>
        {
          this.startPromise = undefined
        })
    }
    return this.startPromise
  }

  private assertConnection(
    connection: MessageConnection,
    signal: AbortSignal
  ): void
  {
    signal.throwIfAborted()
    if (this.disposed || !this.started || this.connection !== connection)
      throw new Error('TypeScript language server is unavailable')
  }

  private async notifyDocument(
    connection: MessageConnection,
    method: string,
    params: unknown,
    signal: AbortSignal,
    path: string,
    version: number,
    commit: () => void
  ): Promise<void>
  {
    this.assertConnection(connection, signal)
    try
    {
      await controlledRequest(
        () => connection.sendNotification(method, params),
        REQUEST_TIMEOUT_MS,
        `Code intelligence ${method}`,
        signal
      )
      this.assertConnection(connection, signal)
      commit()
    }
    catch (error)
    {
      if (this.connection === connection)
      {
        if (signal.aborted)
        {
          // the write may have landed; full-text syncs repair it next query
          this.documents.set(path, { version })
        }
        else
        {
          // a failed write may have reached the server; never reuse that overlay
          this.markStopped(new Error(toErrorMessage(error)))
          await this.stopProcess()
        }
      }
      throw error
    }
  }

  private async syncDocument(
    path: string,
    file: TextFileReadResult,
    connection: MessageConnection,
    signal: AbortSignal,
    required: boolean
  ): Promise<void>
  {
    this.assertConnection(connection, signal)
    const uri = pathToFileURL(path).href
    const current = this.documents.get(path)
    if (!file.ok)
    {
      if (current)
      {
        await this.notifyDocument(
          connection,
          'textDocument/didClose',
          { textDocument: { uri } },
          signal,
          path,
          current.version,
          () => this.documents.delete(path)
        )
      }
      // the server reads closed dependencies itself; only the target can fail
      if (required) throw new Error(file.message)
      return
    }

    if (!current)
    {
      await this.notifyDocument(
        connection,
        'textDocument/didOpen',
        {
          textDocument: {
            uri,
            languageId: codeIntelLanguageId(path),
            version: 1,
            text: file.content,
          },
        },
        signal,
        path,
        1,
        () => this.documents.set(path, { version: 1, content: file.content })
      )
      return
    }

    if (current.content !== file.content)
    {
      const next = current.version + 1
      await this.notifyDocument(
        connection,
        'textDocument/didChange',
        {
          textDocument: { uri, version: next },
          contentChanges: [{ text: file.content }],
        },
        signal,
        path,
        next,
        () => this.documents.set(path, { version: next, content: file.content })
      )
    }
  }

  private async sendRequest<T>(
    connection: MessageConnection,
    method: string,
    params: unknown,
    signal: AbortSignal
  ): Promise<T>
  {
    this.assertConnection(connection, signal)
    const result = await controlledRequest(
      (source) => connection.sendRequest<T>(method, params, source.token),
      REQUEST_TIMEOUT_MS,
      `Code intelligence ${method}`,
      signal
    )
    this.assertConnection(connection, signal)
    return result
  }

  // request complete categories after sync; push notifications can be stale or partial
  private async queryDiagnostics(
    path: string,
    connection: MessageConnection,
    signal: AbortSignal
  ): Promise<string>
  {
    this.assertConnection(connection, signal)
    const commands = [
      'syntacticDiagnosticsSync',
      'semanticDiagnosticsSync',
      'suggestionDiagnosticsSync',
    ]
    const results = await controlledRequest(
      (source) =>
        Promise.all(
          commands.map((command) =>
            connection.sendRequest<unknown>(
              'workspace/executeCommand',
              {
                command: 'typescript.tsserverRequest',
                arguments: [
                  command,
                  { file: path },
                  { executionTarget: 0, expectsResult: true, isAsync: false },
                ],
              },
              source.token
            )
          )
        ),
      DIAGNOSTICS_TIMEOUT_MS,
      'TypeScript diagnostics',
      signal
    )
    this.assertConnection(connection, signal)
    return formatDiagnostics(
      results.flatMap(diagnosticResponse),
      this.cwd,
      path
    )
  }

  private async queryTransaction(
    request: CodeIntelQuery,
    signal: AbortSignal
  ): Promise<string>
  {
    signal.throwIfAborted()
    const path = resolve(this.cwd, request.path)
    if (!codeIntelLanguageId(path))
    {
      throw new Error(
        `Unsupported code-intelligence file type: ${extname(path) || '(none)'}`
      )
    }

    const line = request.line
    const character = request.character
    if (
      request.operation !== 'diagnostics' &&
      (!Number.isInteger(line) ||
        !Number.isInteger(character) ||
        line! < 1 ||
        character! < 1)
    )
    {
      throw new Error(
        `${request.operation} requires integer line and character values`
      )
    }

    const target = await readRequiredTextFile(path, { signal })
    signal.throwIfAborted()
    if (!target.ok && !this.started) throw new Error(target.message)
    await this.ensureStarted(signal)
    const connection = this.connection
    if (!connection)
      throw new Error('TypeScript language server is unavailable')
    this.assertConnection(connection, signal)
    // refresh only overlays we retained; unopened workspace files stay server-owned
    const retained = [...this.documents.keys()].filter((open) => open !== path)
    const files = await Promise.all(
      retained.map((open) => readRequiredTextFile(open, { signal }))
    )
    for (const [index, open] of retained.entries())
    {
      await this.syncDocument(open, files[index]!, connection, signal, false)
    }
    await this.syncDocument(path, target, connection, signal, true)
    if (request.operation === 'diagnostics')
      return this.queryDiagnostics(path, connection, signal)

    const uri = pathToFileURL(path).href
    const params = {
      textDocument: { uri },
      position: { line: line! - 1, character: character! - 1 },
    }

    if (request.operation === 'definition')
    {
      const result = await this.sendRequest<unknown>(
        connection,
        'textDocument/definition',
        params,
        signal
      )
      return formatLocationResult(result, this.cwd, 'definition')
    }
    if (request.operation === 'references')
    {
      const result = await this.sendRequest<unknown>(
        connection,
        'textDocument/references',
        { ...params, context: { includeDeclaration: true } },
        signal
      )
      return formatLocationResult(result, this.cwd, 'references')
    }

    const result = await this.sendRequest<unknown>(
      connection,
      'textDocument/hover',
      params,
      signal
    )
    return formatHoverResult(result)
  }

  query(request: CodeIntelQuery): Promise<string>
  {
    const signal = request.signal
      ? AbortSignal.any([request.signal, this.lifetime.signal])
      : this.lifetime.signal
    const work = this.queryTail.then(() =>
      this.queryTransaction(request, signal)
    )
    this.queryTail = work.then(
      () => undefined,
      () => undefined
    )
    return waitForQuery(work, signal)
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

  dispose(): Promise<void>
  {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.lifetime.abort()
    this.disposePromise = (async () =>
    {
      await this.queryTail
      await this.startPromise?.catch(() => undefined)
      await this.stopProcess()
    })()
    return this.disposePromise
  }
}
