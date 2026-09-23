// integrations/image-inspector/test/inspect-image.test.js
// protect staged reads, the image contract, and request cancellation

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import sharp from 'sharp'
import { inspectImage } from '../inspect-image.js'

function deferred()
{
  let resolve
  const promise = new Promise((done) =>
  {
    resolve = done
  })
  return { promise, resolve }
}

async function within(promise, milliseconds = 3_000)
{
  let timer
  try
  {
    return await Promise.race([
      promise,
      new Promise((_, reject) =>
      {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for observable behavior.')),
          milliseconds
        )
      }),
    ])
  }
  finally
  {
    clearTimeout(timer)
  }
}

async function fixture(t, handler)
{
  const directory = await mkdtemp(join(tmpdir(), 'coral-image-inspector-'))
  const root = join(directory, 'staged')
  await mkdir(root)
  const image = join(root, 'fixture.png')
  await sharp({
    create: { width: 3_000, height: 100, channels: 3, background: 'white' },
  })
    .png()
    .toFile(image)
  const requests = []
  const http = createServer(async (request, response) =>
  {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    handler(body, response, requests.length)
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  t.after(async () =>
  {
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const settings = {
    root,
    model: 'qwen3.5:4b',
    ollamaUrl: `http://127.0.0.1:${http.address().port}`,
  }
  return { directory, root, image, requests, settings }
}

function success(
  response,
  content = 'Answer: white rectangle.\nVisible text: none.\nUncertainty: none.'
)
{
  response.setHeader('Content-Type', 'application/json')
  response.end(
    JSON.stringify({
      model: 'qwen3.5:4b',
      done: true,
      done_reason: 'stop',
      message: { content, thinking: 'PRIVATE REASONING' },
    })
  )
}

test('file boundary rejects unsafe or invalid inputs before inference', async (t) =>
{
  const state = await fixture(t, (_, response) => success(response))
  const allowed = await inspectImage(
    { path: state.image, question: 'Describe this.' },
    state.settings
  )
  assert.equal(allowed.isError, undefined)
  assert.equal(state.requests.length, 1)
  const outside = join(state.directory, 'outside.png')
  await writeFile(outside, 'outside sentinel')
  const linked = join(state.root, 'escape.png')
  await symlink(outside, linked)
  const disguised = join(state.root, 'disguised.png')
  await writeFile(disguised, 'not an image')
  const oversized = join(state.root, 'oversized.png')
  await writeFile(oversized, Buffer.alloc(10 * 1024 * 1024 + 1))
  for (const path of [
    outside,
    linked,
    disguised,
    oversized,
    state.root,
    'relative.png',
    'https://example.com/image.png',
  ])
  {
    const result = await inspectImage(
      { path, question: 'Read it.' },
      state.settings
    )
    assert.equal(result.isError, true, path)
    assert.equal(state.requests.length, 1, `${path} must not reach inference`)
  }
})

test('image wire contract returns bounded observations without image bytes or reasoning', async (t) =>
{
  const state = await fixture(t, (_, response, index) =>
  {
    if (index === 2) return response.end('{broken')
    if (index === 3) return success(response, 'x'.repeat(10_000))
    success(response, 'Answer: white rectangle.')
  })
  const result = await inspectImage(
    { path: state.image, question: 'What is visible?' },
    state.settings
  )
  const request = state.requests[0]
  assert.equal(request.model, 'qwen3.5:4b')
  assert.deepEqual(request.options, { num_ctx: 8_192, num_predict: 1_536 })
  assert.equal(request.think, false)
  assert.equal(request.stream, false)
  assert.equal(request.keep_alive, '2m')
  assert.equal(request.tools, undefined)
  assert.equal(request.messages.length, 2)
  assert.equal(request.messages[1].content, 'What is visible?')
  assert.equal(request.messages[1].images.length, 1)
  const encoded = request.messages[1].images[0]
  const metadata = await sharp(Buffer.from(encoded, 'base64')).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, 2_560)
  assert.equal(metadata.exif, undefined)
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'text')
  assert.match(result.content[0].text, /white rectangle/)
  assert.match(result.content[0].text, /SHA-256: [a-f0-9]{64}/)
  assert.match(result.content[0].text, /Model: qwen3.5:4b/)
  assert.ok(!result.content[0].text.includes(encoded))
  assert.doesNotMatch(result.content[0].text, /PRIVATE REASONING/)
  assert.match(result.content[0].text, /Uncertainty: not explicitly stated/)
  const malformed = await inspectImage(
    { path: state.image, question: 'Read.' },
    state.settings
  )
  assert.equal(malformed.isError, true)
  assert.match(malformed.content[0].text, /malformed JSON/)
  const limited = await inspectImage(
    { path: state.image, question: 'Read.' },
    state.settings
  )
  assert.ok(limited.content[0].text.length <= 8_000)
  assert.match(limited.content[0].text, /output truncated/)
})

test('MCP cancellation and stdin closure abort upstream work and shut down promptly', async (t) =>
{
  let received = deferred()
  let aborted = deferred()
  const state = await fixture(t, (_, response) =>
  {
    response.on('close', () =>
    {
      if (!response.writableFinished) aborted.resolve()
    })
    received.resolve()
  })
  for (const mode of ['cancel', 'eof'])
  {
    received = deferred()
    aborted = deferred()
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../server.js', import.meta.url)),
        '--root',
        state.root,
        '--model',
        state.settings.model,
        '--ollama-url',
        state.settings.ollamaUrl,
      ],
      stderr: 'pipe',
    })
    const client = new Client({
      name: 'image-inspector-test',
      version: '1.0.0',
    })
    t.after(() => client.close())
    await client.connect(transport)
    const pid = transport.pid
    const abort = new AbortController()
    const call = client
      .callTool(
        {
          name: 'inspect_image',
          arguments: { path: state.image, question: 'Read.' },
        },
        undefined,
        { signal: abort.signal }
      )
      .catch((error) => error)
    await within(received.promise)
    if (mode === 'cancel')
    {
      abort.abort()
      await within(aborted.promise)
      await client.close()
    }
    else
    {
      // exercise raw EOF rather than the client's graceful close sequence
      const exited = once(transport._process, 'exit')
      transport._process.stdin.end()
      await within(aborted.promise)
      await within(exited)
    }
    await within(call)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  }
})
