// tests/providers/anthropic-wire.test.ts
// verify Coral history maps onto valid Anthropic turns and back

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import {
  finalChunkFrom,
  toAnthropicMessages,
} from '../../src/providers/anthropic/wire.js'
import type { ModelRequestMessage } from '../../src/types/inference.js'

const MODEL = 'claude-opus-5-5'

const signedTurn = [
  { type: 'thinking', thinking: 'read the file first', signature: 'sig-1' },
  {
    type: 'tool_use',
    id: 'toolu_real',
    name: 'read_file',
    input: { path: 'a.ts' },
  },
]

function history(stateModel: string): ModelRequestMessage[]
{
  return [
    { role: 'system', content: 'base prompt' },
    { role: 'user', content: 'fix a.ts' },
    {
      role: 'assistant',
      content: '',
      thinking: 'read the file first',
      tool_calls: [
        {
          id: 'toolu_real',
          function: { name: 'read_file', arguments: { path: 'a.ts' } },
        },
      ],
      providerState: {
        provider: 'anthropic',
        model: stateModel,
        items: signedTurn,
      },
    },
    { role: 'tool', tool_name: 'read_file', content: 'file body' },
    { role: 'system', content: '## Git Context\n- branch: main' },
    { role: 'user', content: 'files changed on disk' },
  ]
}

test('leading system lifts, later system and tool results share one user turn', () =>
{
  const { system, messages } = toAnthropicMessages(history(MODEL), MODEL)

  assert.equal(system, 'base prompt')
  assert.deepEqual(
    messages.map((turn) => turn.role),
    ['user', 'assistant', 'user']
  )
  const followUp = messages[2]!.content as { type: string }[]
  assert.deepEqual(
    followUp.map((block) => block.type),
    ['tool_result', 'text', 'text']
  )
  assert.equal(
    (followUp[0] as { tool_use_id: string }).tool_use_id,
    'toolu_real'
  )
})

test('signed blocks replay verbatim on the same model and rebuild after a switch', () =>
{
  const same = toAnthropicMessages(history(MODEL), MODEL).messages[1]!
  assert.deepEqual(same.content, signedTurn)

  const switched = toAnthropicMessages(history('claude-sonnet-5-5'), MODEL)
    .messages[1]!
  const blocks = switched.content as { type: string; id?: string }[]
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['tool_use']
  )
  assert.equal(blocks[0]!.id, 'toolu_real')
})

test('legacy history without call ids pairs results by synthesized ids', () =>
{
  const { messages } = toAnthropicMessages(
    [
      { role: 'system', content: 'base prompt' },
      { role: 'user', content: 'list and read' },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [
          { function: { name: 'list_files', arguments: {} } },
          { function: { name: 'read_file', arguments: { path: 'b.ts' } } },
        ],
      },
      { role: 'tool', tool_name: 'list_files', content: 'b.ts' },
      { role: 'tool', tool_name: 'read_file', content: 'Error: missing' },
    ],
    MODEL
  )

  const uses = (messages[1]!.content as { type: string; id?: string }[])
    .filter((block) => block.type === 'tool_use')
    .map((block) => block.id)
  const results = messages[2]!.content as {
    tool_use_id: string
    is_error?: boolean
  }[]
  assert.deepEqual(uses, ['coral_2_0', 'coral_2_1'])
  assert.deepEqual(
    results.map((block) => block.tool_use_id),
    uses
  )
  assert.equal(results[1]!.is_error, true)
})

test('the terminal chunk carries whole calls, summed usage, and replay state', () =>
{
  const message = {
    content: signedTurn,
    stop_reason: 'tool_use',
    stop_details: null,
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 9_000,
      cache_creation_input_tokens: 400,
      output_tokens: 250,
    },
    input_transformations: [
      {
        type: 'thinking_dropped',
        path: 'messages.1.content.0',
        reason: 'prefix_binding_mismatch',
      },
    ],
  } as unknown as BetaMessage

  const chunk = finalChunkFrom(message, MODEL)

  assert.equal(chunk.done, true)
  assert.equal(chunk.prompt_eval_count, 9_500)
  assert.equal(chunk.eval_count, 250)
  assert.equal(chunk.cached_prompt_count, 9_000)
  assert.equal(chunk.dropped_thinking_count, 1)
  assert.deepEqual(chunk.message.tool_calls, [
    {
      id: 'toolu_real',
      type: 'function',
      function: { name: 'read_file', arguments: { path: 'a.ts' } },
    },
  ])
  assert.deepEqual(chunk.message.providerState, {
    provider: 'anthropic',
    model: MODEL,
    items: signedTurn,
  })
})

test('a truncated tool call fails instead of running', () =>
{
  const message = {
    content: [signedTurn[1]],
    stop_reason: 'max_tokens',
    stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as BetaMessage

  assert.throws(() => finalChunkFrom(message, MODEL), /output token limit/)
})
