// src/cli/acp.ts
// serve Coral ACP over stdio without loading the interactive TUI

import { Readable, Writable } from 'node:stream'
import { parseCliArgs } from './args.js'
import * as acp from '@agentclientprotocol/sdk'
import { normalizeOllamaHost } from '../ollama/host.js'
import { boundedDiagnostic } from '../acp/errors.js'

export interface CoralAcpCliOptions
{
  host: string
  model?: string
}

interface CoralAcpCliDependencies
{
  serve?: (options: CoralAcpCliOptions) => Promise<void>
  writeStderr?: (text: string) => void
}

export async function serveAcpStdio(
  options: CoralAcpCliOptions
): Promise<void>
{
  const { CoralAcpController } = await import('../acp/controller.js')
  const controller = new CoralAcpController(options)
  const app = controller.createApp()
  // node's adapter types are wider than ACP's byte-only NDJSON contract
  const output = Writable.toWeb(
    process.stdout
  ) as unknown as WritableStream<Uint8Array>
  const input = Readable.toWeb(
    process.stdin
  ) as unknown as ReadableStream<Uint8Array>
  const stream = acp.ndJsonStream(output, input)
  const connection = app.connect(stream)
  const abortForSignal = (): void => connection.close()
  process.once('SIGINT', abortForSignal)
  process.once('SIGTERM', abortForSignal)

  try
  {
    await connection.closed
  }
  finally
  {
    process.off('SIGINT', abortForSignal)
    process.off('SIGTERM', abortForSignal)
    await controller.shutdown()
  }
}

export async function runAcpCli(
  input: string[] | CoralAcpCliOptions,
  dependencies: CoralAcpCliDependencies = {}
): Promise<number>
{
  const writeStderr =
    dependencies.writeStderr ?? ((text: string) => process.stderr.write(text))
  try
  {
    const result = Array.isArray(input)
      ? parseCliArgs(['acp', ...input])
      : { kind: 'acp' as const, options: input }
    if (result.kind === 'exit') return result.code
    const parsed = result.options
    const model = parsed.model?.trim()
    if (parsed.model !== undefined && !model)
    {
      throw new Error('model must be nonempty')
    }
    await (dependencies.serve ?? serveAcpStdio)({
      host: normalizeOllamaHost(parsed.host),
      ...(model ? { model } : {}),
    })
    return 0
  }
  catch (error)
  {
    writeStderr(`Cannot start Coral ACP: ${boundedDiagnostic(error)}\n`)
    return 1
  }
}
