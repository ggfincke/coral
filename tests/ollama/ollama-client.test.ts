// tests/ollama/ollama-client.test.ts
// regression tests for Ollama keep-alive & think behavior

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { OllamaClient } from '../../src/ollama/client.js'
import { normalizeOllamaHost } from '../../src/ollama/host.js'
import type { ChatRequest } from '../../src/types/inference.js'
import { parseFetchJsonBody, withFetch } from '../helpers/fetch.js'

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

test('normalizeOllamaHost canonicalizes identity and rejects unsafe URL parts', () =>
{
  assert.equal(
    normalizeOllamaHost('HTTP://OLLAMA.TEST:80/proxy///'),
    'http://ollama.test/proxy'
  )
  assert.equal(
    normalizeOllamaHost('https://ollama.test:443/'),
    'https://ollama.test'
  )
  assert.throws(
    () => normalizeOllamaHost('ftp://ollama.test'),
    /use http or https/
  )
  assert.throws(
    () => normalizeOllamaHost('http://user:secret@ollama.test'),
    /cannot include credentials/
  )
  assert.throws(
    () => normalizeOllamaHost('http://ollama.test?tenant=a'),
    /query string or fragment/
  )
})

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

test('chatStream allowlists request, message, tool, & tool-call wire fields', async () =>
{
  let requestBody: Record<string, unknown> | undefined

  await withFetch(
    async (_input, init) =>
    {
      requestBody = parseFetchJsonBody(init)
      return buildNdjsonResponse([
        { message: { role: 'assistant', content: 'done' }, done: true },
      ])
    },
    async () =>
    {
      const client = new OllamaClient('http://localhost:11434')
      const internalRequest = {
        model: 'fake-model',
        messages: [
          {
            role: 'user',
            content: 'captured model content',
            displayContent: 'clean transcript content',
            requestedAttachments: ['secret.txt'],
          },
          {
            role: 'assistant',
            content: '',
            thinking: 'inspect first',
            rogueMessageField: 'must not cross',
            tool_calls: [
              {
                type: 'function',
                rogueCallField: 'must not cross',
                function: {
                  index: 0,
                  name: 'inspect_fixture',
                  arguments: { path: 'fixture.txt' },
                  rogueFunctionField: 'must not cross',
                },
              },
            ],
          },
          {
            role: 'tool',
            content: 'fixture result',
            tool_name: 'inspect_fixture',
            rogueToolMessageField: 'must not cross',
          },
        ],
        tools: [
          {
            type: 'function',
            rogueToolField: 'must not cross',
            function: {
              name: 'inspect_fixture',
              description: 'inspect one fixture',
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
              },
              rogueToolFunctionField: 'must not cross',
            },
          },
        ],
        think: 'low',
        num_ctx: 8_192,
        num_predict: 1_024,
        rogueRequestField: 'must not cross',
      } as unknown as ChatRequest

      for await (const _chunk of client.chatStream(internalRequest))
      {
        void _chunk
      }
    }
  )

  assert.deepEqual(requestBody, {
    model: 'fake-model',
    messages: [
      { role: 'user', content: 'captured model content' },
      {
        role: 'assistant',
        content: '',
        thinking: 'inspect first',
        tool_calls: [
          {
            type: 'function',
            function: {
              index: 0,
              name: 'inspect_fixture',
              arguments: { path: 'fixture.txt' },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: 'fixture result',
        tool_name: 'inspect_fixture',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'inspect_fixture',
          description: 'inspect one fixture',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ],
    think: 'low',
    keep_alive: '10m',
    stream: true,
    options: { num_ctx: 8_192, num_predict: 1_024 },
  })
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

test('evictModel explicitly sends host-global keep_alive 0', async () =>
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

      await client.evictModel()

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

test('metadata requests pass the abort signal to fetch', async () =>
{
  const controller = new AbortController()
  const seenSignals: Array<AbortSignal | null | undefined> = []

  await withFetch(
    async (input, init) =>
    {
      seenSignals.push(init?.signal)
      const url = String(input)
      if (url.endsWith('/api/show'))
      {
        return new Response(
          JSON.stringify({
            model_info: {
              'general.architecture': 'gemma',
              'gemma.context_length': 8192,
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      }

      return new Response(JSON.stringify({ models: [] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    },
    async () =>
    {
      const client = new OllamaClient('http://ollama.test')

      await client.showModel('fake-model', controller.signal)
      await client.listModels(controller.signal)

      assert.deepEqual(seenSignals, [controller.signal, controller.signal])
    }
  )
})

test('resolveModelArtifact uses the exact /api/tags manifest digest', async () =>
{
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              name: 'nomic-embed-text:latest',
              model: 'nomic-embed-text:latest',
              size: 1,
              modified_at: '',
              digest: 'A'.repeat(64),
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } }
      ),
    async () =>
    {
      const client = new OllamaClient('HTTP://OLLAMA.TEST:80/')
      assert.deepEqual(await client.resolveModelArtifact('nomic-embed-text'), {
        model: 'nomic-embed-text:latest',
        digest: 'a'.repeat(64),
      })
    }
  )
})

test('resolveModelArtifact rejects missing, malformed, and ambiguous identities', async () =>
{
  const responses = [
    { models: [] },
    {
      models: [
        {
          name: 'embed:latest',
          model: 'embed:latest',
          digest: 'mutable-tag',
        },
      ],
    },
    {
      models: [
        {
          name: 'embed:latest',
          model: 'embed:latest',
          digest: 'a'.repeat(64),
        },
        {
          name: 'EMBED:latest',
          model: 'EMBED:latest',
          digest: 'b'.repeat(64),
        },
      ],
    },
  ]
  let responseIndex = 0

  await withFetch(
    async () =>
      new Response(JSON.stringify(responses[responseIndex++]!), {
        headers: { 'Content-Type': 'application/json' },
      }),
    async () =>
    {
      const client = new OllamaClient('http://ollama.test')
      await assert.rejects(
        () => client.resolveModelArtifact('embed'),
        /is not listed/
      )
      await assert.rejects(
        () => client.resolveModelArtifact('embed'),
        /no valid immutable SHA-256 digest/
      )
      await assert.rejects(
        () => client.resolveModelArtifact('embed'),
        /matches multiple/
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
