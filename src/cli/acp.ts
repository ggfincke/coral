// src/cli/acp.ts
// serve Coral ACP over stdio without loading the interactive TUI

import { Readable, Writable } from 'node:stream'
import { Command, CommanderError } from 'commander'
import * as acp from '@agentclientprotocol/sdk'
import { DEFAULT_OLLAMA_HOST, normalizeOllamaHost } from '../ollama/host.js'
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
  argv: string[],
  dependencies: CoralAcpCliDependencies = {}
): Promise<number>
{
  const writeStderr =
    dependencies.writeStderr ?? ((text: string) => process.stderr.write(text))
  const command = new Command()
    .name('coral acp')
    .description('Serve Coral through the Agent Client Protocol')
    .option('--host <url>', 'Ollama host URL', DEFAULT_OLLAMA_HOST)
    .option('-m, --model <model>', 'default Ollama model for new sessions')
    .exitOverride()

  try
  {
    command.parse(argv, { from: 'user' })
    const parsed = command.opts<{ host: string; model?: string }>()
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
    if (error instanceof CommanderError) return error.exitCode
    writeStderr(`Cannot start Coral ACP: ${boundedDiagnostic(error)}\n`)
    return 1
  }
}
