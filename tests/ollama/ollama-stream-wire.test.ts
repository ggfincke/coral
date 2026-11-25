// tests/ollama/ollama-stream-wire.test.ts
// test Ollama system-message placement on the wire & NDJSON stream framing

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { OllamaClient } from '../../src/ollama/client.js'
import type { ChatRequest, ChatResponse } from '../../src/types/inference.js'
import { parseFetchJsonBody, withFetch } from '../helpers/fetch.js'

const DONE_LINE = '{"message":{"role":"assistant","content":""},"done":true}\n'

async function collect(client: OllamaClient): Promise<ChatResponse[]>
{
  const chunks: ChatResponse[] = []
  for await (const chunk of client.chatStream({
    model: 'fake',
    messages: [],
  }))
  {
    chunks.push(chunk)
  }
  return chunks
}

// a later system message rewriting the leading prompt forces a full re-prefill
// every round (#142); it must stay in place as user text instead
test('chatStream merges only the leading system run and keeps later system text in place', async () =>
{
  const warning =
    'Undo is unavailable for the previous turn: a.ts changed outside Coral.'
  const request: ChatRequest = {
    model: 'fake',
    messages: [
      { role: 'system', content: 'base' },
      { role: 'system', content: 'summary' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'read_file', arguments: { path: 'a.ts' } } },
        ],
      },
      { role: 'tool', content: 'body', tool_name: 'read_file' },
      { role: 'system', content: warning },
      { role: 'system', content: '   ' },
    ],
  }
  let body: { messages?: unknown[] } = {}
  await withFetch(
    async (_input, init) =>
    {
      body = parseFetchJsonBody(init)
      return new Response(DONE_LINE)
    },
    async () =>
    {
      for await (const chunk of new OllamaClient().chatStream(request))
      {
        void chunk
      }
    }
  )

  assert.deepEqual(body.messages, [
    { role: 'system', content: 'base\n\nsummary' },
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'read_file', arguments: { path: 'a.ts' } } },
      ],
    },
    { role: 'tool', content: 'body', tool_name: 'read_file' },
    { role: 'user', content: warning },
  ])
})

// large tool arguments span several reads; a split code point must not decode
// to U+FFFD inside content that is later written to the user's files
test('chatStream reassembles records split across reads and inside a code point', async () =>
{
  const records = [
    { message: { role: 'assistant', content: 'héllo 🙂' }, done: false },
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            function: {
              name: 'write_file',
              arguments: { path: 'a.txt', content: '日本語🙂' },
            },
          },
        ],
      },
      done: false,
    },
    { message: { role: 'assistant', content: '' }, done: true },
  ]
  const bytes = new TextEncoder().encode(
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  )
  const emoji = Buffer.from(bytes).indexOf(Buffer.from('🙂'))
  const firstNewline = bytes.indexOf(10)
  // cut inside a JSON line, inside the 4-byte emoji & right after a newline
  const cuts = [10, emoji + 2, firstNewline + 1, bytes.length - 5, bytes.length]
  const stream = new ReadableStream<Uint8Array>({
    start(controller)
    {
      let from = 0
      for (const cut of cuts)
      {
        controller.enqueue(bytes.subarray(from, cut))
        from = cut
      }
      controller.close()
    },
  })

  const chunks = await withFetch(
    async () => new Response(stream),
    async () => collect(new OllamaClient())
  )
  assert.deepEqual(chunks, records)
})

test('chatStream ends a body that never sends a newline with a bounded error', async () =>
{
  const piece = new TextEncoder().encode('a'.repeat(1024 * 1024))
  let reads = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller)
    {
      reads += 1
      controller.enqueue(piece)
    },
  })

  await withFetch(
    async () => new Response(stream),
    async () =>
    {
      await assert.rejects(
        collect(new OllamaClient()),
        /chat stream sent a line longer than/
      )
    }
  )
  assert.ok(reads < 64, `stream was read ${reads} times before failing`)
})
