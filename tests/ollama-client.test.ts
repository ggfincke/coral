// tests/ollama-client.test.ts
// regression tests for Ollama keep-alive & think behavior

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { OllamaClient } from '../src/ollama/client.js'

function buildNdjsonResponse(lines: unknown[]): Response
{
  return new Response(
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    }
  )
}

test('chatStream defaults keep_alive to 10m', async () =>
{
  const originalFetch = globalThis.fetch
  const requests: unknown[] = []

  globalThis.fetch = (async (_input, init) =>
  {
    requests.push(JSON.parse(String(init?.body ?? '{}')))

    return buildNdjsonResponse([
      {
        message: {
          role: 'assistant',
          content: 'done',
        },
        done: true,
      },
    ])
  }) as typeof fetch

  try
  {
    const client = new OllamaClient('http://localhost:11434')
    const chunks = []

    for await (const chunk of client.chatStream({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
    }))
    {
      chunks.push(chunk)
    }

    assert.equal(chunks.length, 1)
    assert.deepEqual(requests, [
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        keep_alive: '10m',
        stream: true,
      },
    ])
  }
  finally
  {
    globalThis.fetch = originalFetch
  }
})

test('chatStream sends think when requested', async () =>
{
  const originalFetch = globalThis.fetch
  const requests: unknown[] = []

  globalThis.fetch = (async (_input, init) =>
  {
    requests.push(JSON.parse(String(init?.body ?? '{}')))

    return buildNdjsonResponse([
      {
        message: {
          role: 'assistant',
          thinking: 'inspect',
          content: 'done',
        },
        done: true,
      },
    ])
  }) as typeof fetch

  try
  {
    const client = new OllamaClient('http://localhost:11434')

    for await (const chunk of client.chatStream({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      think: true,
    }))
    {
      void chunk
    }

    assert.deepEqual(requests, [
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        think: true,
        keep_alive: '10m',
        stream: true,
      },
    ])
  }
  finally
  {
    globalThis.fetch = originalFetch
  }
})

test('chatStream retries without think when Ollama rejects the flag', async () =>
{
  const originalFetch = globalThis.fetch
  const requests: unknown[] = []
  let callCount = 0

  globalThis.fetch = (async (_input, init) =>
  {
    requests.push(JSON.parse(String(init?.body ?? '{}')))
    callCount += 1

    if (callCount === 1)
    {
      return new Response('json: unknown field "think"', { status: 400 })
    }

    return buildNdjsonResponse([
      {
        message: {
          role: 'assistant',
          content: 'done',
        },
        done: true,
      },
    ])
  }) as typeof fetch

  try
  {
    const client = new OllamaClient('http://localhost:11434')

    for await (const chunk of client.chatStream({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      think: true,
    }))
    {
      void chunk
    }

    for await (const chunk of client.chatStream({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello again' }],
      think: true,
    }))
    {
      void chunk
    }

    assert.deepEqual(requests, [
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        think: true,
        keep_alive: '10m',
        stream: true,
      },
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        keep_alive: '10m',
        stream: true,
      },
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello again' }],
        keep_alive: '10m',
        stream: true,
      },
    ])
  }
  finally
  {
    globalThis.fetch = originalFetch
  }
})

test('think fallback support is tracked per model', async () =>
{
  const originalFetch = globalThis.fetch
  const requests: unknown[] = []

  globalThis.fetch = (async (_input, init) =>
  {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      model?: string
      think?: boolean
    }
    requests.push(body)

    if (body.model === 'model-a' && body.think === true)
    {
      return new Response('json: unknown field "think"', { status: 400 })
    }

    return buildNdjsonResponse([
      {
        message: {
          role: 'assistant',
          content: 'done',
        },
        done: true,
      },
    ])
  }) as typeof fetch

  try
  {
    const client = new OllamaClient('http://localhost:11434')

    for await (const chunk of client.chatStream({
      model: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
      think: true,
    }))
    {
      void chunk
    }

    for await (const chunk of client.chatStream({
      model: 'model-b',
      messages: [{ role: 'user', content: 'hello again' }],
      think: true,
    }))
    {
      void chunk
    }

    assert.deepEqual(requests, [
      {
        model: 'model-a',
        messages: [{ role: 'user', content: 'hello' }],
        think: true,
        keep_alive: '10m',
        stream: true,
      },
      {
        model: 'model-a',
        messages: [{ role: 'user', content: 'hello' }],
        keep_alive: '10m',
        stream: true,
      },
      {
        model: 'model-b',
        messages: [{ role: 'user', content: 'hello again' }],
        think: true,
        keep_alive: '10m',
        stream: true,
      },
    ])
  }
  finally
  {
    globalThis.fetch = originalFetch
  }
})

test('chatStream omits think when reasoning is disabled', async () =>
{
  const originalFetch = globalThis.fetch
  const requests: unknown[] = []

  globalThis.fetch = (async (_input, init) =>
  {
    requests.push(JSON.parse(String(init?.body ?? '{}')))

    return buildNdjsonResponse([
      {
        message: {
          role: 'assistant',
          content: 'done',
        },
        done: true,
      },
    ])
  }) as typeof fetch

  try
  {
    const client = new OllamaClient('http://localhost:11434')

    for await (const chunk of client.chatStream({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      think: false,
    }))
    {
      void chunk
    }

    assert.deepEqual(requests, [
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        keep_alive: '10m',
        stream: true,
      },
    ])
  }
  finally
  {
    globalThis.fetch = originalFetch
  }
})

test('unloadModel sends keep_alive 0 for immediate shutdown', async () =>
{
  const originalFetch = globalThis.fetch
  const requests: unknown[] = []

  globalThis.fetch = (async (_input, init) =>
  {
    requests.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(null, { status: 200 })
  }) as typeof fetch

  try
  {
    const client = new OllamaClient('http://localhost:11434')
    client.startKeepAlive('fake-model')

    await client.unloadModel()

    assert.deepEqual(requests, [
      {
        model: 'fake-model',
        messages: [],
        keep_alive: 0,
        stream: false,
        options: { num_predict: 0 },
      },
    ])
  }
  finally
  {
    globalThis.fetch = originalFetch
  }
})

test('embed posts batched input to Ollama embed endpoint', async () =>
{
  const originalFetch = globalThis.fetch
  const requests: { url: string; body: unknown }[] = []

  globalThis.fetch = (async (input, init) =>
  {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')),
    })

    return new Response(
      JSON.stringify({
        embeddings: [
          [1, 0],
          [0, 1],
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }) as typeof fetch

  try
  {
    const client = new OllamaClient('http://ollama.test')
    const embeddings = await client.embed('nomic-embed-text', [
      'auth flow',
      'render button',
    ])

    assert.deepEqual(embeddings, [
      [1, 0],
      [0, 1],
    ])
    assert.deepEqual(requests, [
      {
        url: 'http://ollama.test/api/embed',
        body: {
          model: 'nomic-embed-text',
          input: ['auth flow', 'render button'],
          keep_alive: '10m',
        },
      },
    ])
  }
  finally
  {
    globalThis.fetch = originalFetch
  }
})
