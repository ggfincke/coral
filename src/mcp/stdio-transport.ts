// src/mcp/stdio-transport.ts
// bounded stdio JSON-RPC transport

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough, type Stream } from 'node:stream'
import {
  deserializeMessage,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { toError } from '../utils/errors.js'

const MAX_MCP_MESSAGE_BYTES = 16 * 1024 * 1024
const MAX_MCP_BUFFER_CHUNKS = 8_192

class McpTransportLimitError extends Error
{}

interface CoralStdioServerParameters
{
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

// retain pipe chunks until a complete line is available, then copy once
class JsonLineBuffer
{
  private chunks: Buffer[] = []
  private scanIndex = 0
  private totalBytes = 0

  append(chunk: Buffer): void
  {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.totalBytes += chunk.length
    if (this.chunks.length > MAX_MCP_BUFFER_CHUNKS)
    {
      throw new McpTransportLimitError(
        `MCP message exceeds ${MAX_MCP_BUFFER_CHUNKS} fragment buffer limit`
      )
    }
  }

  readMessage(): JSONRPCMessage | null
  {
    for (let index = this.scanIndex; index < this.chunks.length; index++)
    {
      const chunk = this.chunks[index]!
      const newline = chunk.indexOf(10)
      if (newline < 0) continue

      let lineBytes = newline
      for (let prefix = 0; prefix < index; prefix++)
      {
        lineBytes += this.chunks[prefix]!.length
      }
      if (lineBytes > MAX_MCP_MESSAGE_BYTES)
      {
        throw new McpTransportLimitError(
          `MCP message exceeds ${MAX_MCP_MESSAGE_BYTES} byte protocol limit`
        )
      }

      const line = Buffer.allocUnsafe(lineBytes)
      let offset = 0
      for (let prefix = 0; prefix < index; prefix++)
      {
        offset += this.chunks[prefix]!.copy(line, offset)
      }
      chunk.copy(line, offset, 0, newline)

      const remainder = chunk.subarray(newline + 1)
      const trailing = this.chunks.slice(index + 1)
      this.chunks = remainder.length > 0 ? [remainder, ...trailing] : trailing
      this.totalBytes -= lineBytes + 1
      this.scanIndex = 0

      return deserializeMessage(line.toString('utf8').replace(/\r$/, ''))
    }

    this.scanIndex = this.chunks.length
    if (this.totalBytes > MAX_MCP_MESSAGE_BYTES)
    {
      throw new McpTransportLimitError(
        `MCP message exceeds ${MAX_MCP_MESSAGE_BYTES} byte protocol limit`
      )
    }
    return null
  }

  clear(): void
  {
    this.chunks = []
    this.scanIndex = 0
    this.totalBytes = 0
  }
}

// match the SDK stdio lifecycle while bounding message buffers
export class CoralStdioClientTransport implements Transport
{
  private readonly params: CoralStdioServerParameters
  private readonly readBuffer = new JsonLineBuffer()
  private readonly stderrStream = new PassThrough()
  private child?: ChildProcessWithoutNullStreams
  private acceptingStdout = true

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T) => void

  constructor(params: CoralStdioServerParameters)
  {
    this.params = params
  }

  get stderr(): Stream
  {
    return this.stderrStream
  }

  get pid(): number | null
  {
    return this.child?.pid ?? null
  }

  async start(): Promise<void>
  {
    if (this.child) throw new Error('MCP stdio transport already started')

    await new Promise<void>((resolve, reject) =>
    {
      const child = spawn(this.params.command, this.params.args, {
        cwd: this.params.cwd,
        env: this.params.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.child = child

      child.once('error', (error) =>
      {
        reject(error)
        this.onerror?.(error)
      })
      child.once('spawn', resolve)
      child.once('close', () =>
      {
        if (this.child === child) this.child = undefined
        this.onclose?.()
      })
      child.stdin.on('error', (error) => this.onerror?.(error))
      child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk))
      child.stdout.on('error', (error) => this.onerror?.(error))
      child.stderr.pipe(this.stderrStream)
    })
  }

  async close(): Promise<void>
  {
    this.acceptingStdout = false
    this.readBuffer.clear()
    const child = this.child
    this.child = undefined
    if (child)
    {
      const closed = new Promise<void>((resolve) =>
        child.once('close', resolve)
      )
      try
      {
        child.stdin.end()
      }
      catch
      {
        // ignore a close race when stdin is already closed
      }

      await Promise.race([closed, this.closeDelay()])
      if (child.exitCode === null)
      {
        try
        {
          child.kill('SIGTERM')
        }
        catch
        {
          // ignore a close race between the check and signal
        }
        await Promise.race([closed, this.closeDelay()])
      }
      if (child.exitCode === null)
      {
        try
        {
          child.kill('SIGKILL')
        }
        catch
        {
          // ignore a close race between the check and signal
        }
      }
    }
  }

  send(message: JSONRPCMessage): Promise<void>
  {
    return new Promise((resolve, reject) =>
    {
      const stdin = this.child?.stdin
      if (!stdin)
      {
        reject(new Error('MCP stdio transport is not connected'))
        return
      }
      if (stdin.write(serializeMessage(message))) resolve()
      else stdin.once('drain', resolve)
    })
  }

  private handleStdout(chunk: Buffer): void
  {
    if (!this.acceptingStdout) return
    try
    {
      this.readBuffer.append(chunk)
    }
    catch (error)
    {
      this.failTransport(toError(error))
      return
    }

    while (this.acceptingStdout)
    {
      try
      {
        const message = this.readBuffer.readMessage()
        if (!message) return
        this.onmessage?.(message)
      }
      catch (error)
      {
        const normalized = toError(error)
        if (normalized instanceof McpTransportLimitError)
        {
          this.failTransport(normalized)
          return
        }
        this.onerror?.(normalized)
      }
    }
  }

  private failTransport(error: Error): void
  {
    this.acceptingStdout = false
    this.readBuffer.clear()
    this.onerror?.(error)
    void this.close()
  }

  private closeDelay(): Promise<void>
  {
    return new Promise((resolve) => setTimeout(resolve, 2_000).unref())
  }
}
