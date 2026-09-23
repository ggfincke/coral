// tests/cli/acp.test.ts
// protect ACP CLI parsing without opening a protocol subprocess

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { TransformStream } from 'node:stream/web'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as acp from '@agentclientprotocol/sdk'
import { runAcpCli } from '../../src/cli/acp.js'

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..'
)

test('ACP CLI canonicalizes runtime options before serving stdio', async () =>
{
  let seen: { host: string; model?: string } | undefined
  const exitCode = await runAcpCli(
    ['--host', 'HTTP://OLLAMA.TEST:80/proxy///', '--model', ' model-a '],
    {
      serve: async (options) =>
      {
        seen = options
      },
    }
  )

  assert.equal(exitCode, 0)
  assert.deepEqual(seen, {
    host: 'http://ollama.test/proxy',
    model: 'model-a',
  })
})

test('ACP CLI reports startup errors on stderr', async () =>
{
  const errors: string[] = []
  const exitCode = await runAcpCli(['--host', 'file:///tmp/ollama'], {
    serve: async () => assert.fail('invalid options must not start ACP'),
    writeStderr: (text) => errors.push(text),
  })

  assert.equal(exitCode, 1)
  assert.deepEqual(errors, [
    'Cannot start Coral ACP: Invalid Ollama host protocol file:; use http or https\n',
  ])
})

interface SubprocessResult<T>
{
  result: T
  stderr: string
  stdout: string
}

async function runAcpSubprocess<T>(
  host: string,
  coralHome: string,
  run: (context: acp.ClientContext) => Promise<T>
): Promise<SubprocessResult<T>>
{
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/cli/main.tsx',
      'acp',
      '--host',
      host,
      '--model',
      'model-a',
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        CORAL_HOME: coralHome,
        CORAL_NUM_CTX: '8192',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  let stdout = ''
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) =>
  {
    stderr += chunk
  })
  const copiedOutput = new TransformStream<Uint8Array, Uint8Array>()
  const copiedWriter = copiedOutput.writable.getWriter()
  const outputCapture = new TextDecoder()
  child.stdout.on('data', (chunk: Buffer) =>
  {
    stdout += outputCapture.decode(chunk, { stream: true })
    void copiedWriter.write(chunk)
  })
  child.stdout.on('end', () =>
  {
    stdout += outputCapture.decode()
    void copiedWriter.close()
  })
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    copiedOutput.readable
  )
  let result: T
  try
  {
    const connection = acp
      .client({ name: 'coral-subprocess-test' })
      .onNotification(acp.methods.client.session.update, () =>
      {})
      .connect(stream)
    try
    {
      result = await run(connection.agent)
    }
    finally
    {
      child.stdin.end()
      await connection.closed.catch(() => undefined)
    }
  }
  finally
  {
    if (!child.stdin.destroyed) child.stdin.end()
  }

  const [exitCode, exitSignal] = (await once(child, 'exit', {
    signal: AbortSignal.timeout(10_000),
  })) as [number | null, NodeJS.Signals | null]
  assert.equal(exitSignal, null)
  assert.equal(exitCode, 0, stderr)
  return { result, stderr, stdout }
}

async function startFakeOllama(): Promise<{
  host: string
  server: Server
}>
{
  let replyNumber = 0
  const server = createServer((request, response) =>
  {
    if (request.url === '/api/tags')
    {
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          models: [
            {
              name: 'model-a',
              size: 1,
              modified_at: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
      )
      return
    }
    if (request.url === '/api/show')
    {
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          model_info: {
            'general.architecture': 'gemma4',
            'gemma4.context_length': 32_768,
          },
        })
      )
      return
    }
    if (request.url === '/api/chat')
    {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () =>
      {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages?: unknown[]
          stream?: boolean
        }
        if (body.stream === false || body.messages?.length === 0)
        {
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ done: true }))
          return
        }
        replyNumber++
        response.setHeader('Content-Type', 'application/x-ndjson')
        response.end(
          `${JSON.stringify({
            model: 'model-a',
            created_at: '2026-08-13T12:00:00.000Z',
            message: {
              role: 'assistant',
              content: `subprocess reply ${replyNumber}`,
            },
            done: true,
            prompt_eval_count: 10,
            eval_count: 4,
          })}\n`
        )
      })
      return
    }

    response.statusCode = 404
    response.end('not found')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { host: `http://127.0.0.1:${address.port}`, server }
}

test('actual coral acp subprocess keeps stdout pure across fresh and resumed turns', async () =>
{
  const root = await mkdtemp(join(tmpdir(), 'coral-acp-subprocess-'))
  const workspace = await mkdtemp(join(root, 'workspace-'))
  const coralHome = join(root, 'home')
  const { host, server } = await startFakeOllama()
  try
  {
    const fresh = await runAcpSubprocess(host, coralHome, async (context) =>
    {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      const created = await context.request(acp.methods.agent.session.new, {
        cwd: workspace,
        mcpServers: [],
      })
      const prompted = await context.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'fresh turn' }],
      })
      assert.equal(prompted.stopReason, 'end_turn')
      await context.request(acp.methods.agent.session.close, {
        sessionId: created.sessionId,
      })
      return created.sessionId
    })
    assert.equal(fresh.stderr, '')

    const resumed = await runAcpSubprocess(host, coralHome, async (context) =>
    {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      await context.request(acp.methods.agent.session.resume, {
        sessionId: fresh.result,
        cwd: workspace,
        mcpServers: [],
      })
      const prompted = await context.request(acp.methods.agent.session.prompt, {
        sessionId: fresh.result,
        prompt: [{ type: 'text', text: 'resumed turn' }],
      })
      assert.equal(prompted.stopReason, 'end_turn')
      await context.request(acp.methods.agent.session.close, {
        sessionId: fresh.result,
      })
    })
    assert.equal(resumed.stderr, '')

    for (const output of [fresh.stdout, resumed.stdout])
    {
      const lines = output.trim().split('\n')
      assert.ok(lines.length > 0)
      for (const line of lines)
      {
        const message = JSON.parse(line) as { jsonrpc?: string }
        assert.equal(message.jsonrpc, '2.0')
      }
    }
  }
  finally
  {
    server.close()
    await once(server, 'close')
    await rm(root, { recursive: true, force: true })
  }
})
