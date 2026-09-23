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
import { readRequiredTextFile } from '../utils/file-read.js'
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

interface OpenDocument
{
  version: number
  content: string
}

interface SyncedDocument
{
  uri: string
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
    const id = codeIntelLanguageId(path)
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
      return { uri }
    }

    if (current.content !== file.content)
    {
      const next = current.version + 1
      this.documents.set(path, { version: next, content: file.content })
      await connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: next },
        contentChanges: [{ text: file.content }],
      })
      return { uri }
    }
    return { uri }
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

  // request complete categories after sync; push notifications can be stale or partial
  private async queryDiagnostics(
    path: string,
    signal?: AbortSignal
  ): Promise<string>
  {
    await this.syncDocument(path, signal)
    const connection = this.connection
    if (!connection)
      throw new Error('TypeScript language server is unavailable')
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
    return formatDiagnostics(
      results.flatMap(diagnosticResponse),
      this.cwd,
      path
    )
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
