// tests/ollama-client.test.ts
// regression tests for Ollama keep-alive & think behavior

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { OllamaClient } from '../src/ollama/client.js'
import { parseFetchJsonBody, withFetch } from './helpers/fetch.js'

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
  const requests: unknown[] = []

  await withFetch(
    async (_input, init) =>
    {
      requests.push(parseFetchJsonBody(init))

      return buildNdjsonResponse([
        {
          message: {
            role: 'assistant',
            content: 'done',
          },
          done: true,
        },
      ])
    },
    async () =>
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
  )
})

test('chatStream nests num_ctx and num_predict under options', async () =>
{
  const requests: Record<string, unknown>[] = []

  await withFetch(
    async (_input, init) =>
    {
      requests.push(parseFetchJsonBody(init))

      return buildNdjsonResponse([
        { message: { role: 'assistant', content: 'done' }, done: true },
      ])
    },
    async () =>
    {
      const client = new OllamaClient('http://localhost:11434')

      for await (const _chunk of client.chatStream({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        num_ctx: 32_768,
        num_predict: 16_384,
      }))
      {
        void _chunk
      }

      assert.deepEqual(requests[0]!.options, {
        num_ctx: 32_768,
        num_predict: 16_384,
      })
      assert.equal('num_ctx' in requests[0]!, false)
      assert.equal('num_predict' in requests[0]!, false)
    }
  )
})

test('chatStream sends think when requested', async () =>
{
  const requests: unknown[] = []

  await withFetch(
    async (_input, init) =>
    {
      requests.push(parseFetchJsonBody(init))

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
    },
    async () =>
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
  )
})

test('think fallback is tracked per model', async () =>
{
  const requests: unknown[] = []

  await withFetch(
    async (_input, init) =>
    {
      const body = parseFetchJsonBody<{
        model?: string
        think?: boolean
      }>(init)
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
    },
    async () =>
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

      // second model-a call: memory persists, so think is omitted from the start
      for await (const chunk of client.chatStream({
        model: 'model-a',
        messages: [{ role: 'user', content: 'hello again' }],
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
          model: 'model-a',
          messages: [{ role: 'user', content: 'hello again' }],
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
  )
})

test('unloadModel sends keep_alive 0 for immediate shutdown', async () =>
{
  const requests: unknown[] = []

  await withFetch(
    async (_input, init) =>
    {
      requests.push(parseFetchJsonBody(init))
      return new Response(null, { status: 200 })
    },
    async () =>
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
  )
})

test('embed posts batched input to Ollama embed endpoint', async () =>
{
  const requests: { url: string; body: unknown }[] = []

  await withFetch(
    async (input, init) =>
    {
      requests.push({
        url: String(input),
        body: parseFetchJsonBody(init),
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
    },
    async () =>
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
  )
})

test('showModel includes Ollama API error bodies', async () =>
{
  await withFetch(
    async () =>
    {
      return new Response('model not found', { status: 404 })
    },
    async () =>
    {
      const client = new OllamaClient('http://ollama.test')

      await assert.rejects(
        () => client.showModel('missing-model'),
        /Ollama API error: 404 model not found/
      )
    }
  )
})

test('embed translates fetch failures with host context', async () =>
{
  await withFetch(
    async () =>
    {
      throw new Error('socket closed')
    },
    async () =>
    {
      const client = new OllamaClient('http://ollama.test')

      await assert.rejects(
        () => client.embed('nomic-embed-text', ['auth flow']),
        /Cannot reach Ollama at http:\/\/ollama\.test: socket closed/
      )
    }
  )
})

test('embed preserves Ollama API error text', async () =>
{
  await withFetch(
    async () =>
    {
      return new Response('pull model first', { status: 404 })
    },
    async () =>
    {
      const client = new OllamaClient('http://ollama.test')

      await assert.rejects(
        () => client.embed('nomic-embed-text', ['auth flow']),
        /Ollama API error: 404 pull model first/
      )
    }
  )
})

test('embed rejects missing embeddings', async () =>
{
  await withFetch(
    async () =>
    {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
    async () =>
    {
      const client = new OllamaClient('http://ollama.test')

      await assert.rejects(
        () => client.embed('nomic-embed-text', ['auth flow']),
        /did not include embeddings/
      )
    }
  )
})

test('embed rejects response count mismatches', async () =>
{
  await withFetch(
    async () =>
    {
      return new Response(JSON.stringify({ embeddings: [[1, 0]] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
    async () =>
    {
      const client = new OllamaClient('http://ollama.test')

      await assert.rejects(
        () => client.embed('nomic-embed-text', ['auth flow', 'render button']),
        /count mismatch: expected 2, got 1/
      )
    }
  )
})

test('embed rejects malformed embedding vectors', async () =>
{
  await withFetch(
    async () =>
    {
      return new Response(JSON.stringify({ embeddings: [['bad']] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
    async () =>
    {
      const client = new OllamaClient('http://ollama.test')

      await assert.rejects(
        () => client.embed('nomic-embed-text', ['auth flow']),
        /invalid embedding/
      )
    }
  )
})

test('embed rejects empty embedding vectors', async () =>
{
  await withFetch(
    async () =>
    {
      return new Response(JSON.stringify({ embeddings: [[]] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
    async () =>
    {
      const client = new OllamaClient('http://ollama.test')

      await assert.rejects(
        () => client.embed('nomic-embed-text', ['auth flow']),
        /invalid embedding/
      )
    }
  )
})
