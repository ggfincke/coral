// tests/providers/openai-wire.test.ts
// verify Coral history maps onto stateless Responses input items and back

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { Response } from 'openai/resources/responses/responses'
import {
  finalChunkFrom,
  toOpenAIInput,
} from '../../src/providers/openai/wire.js'
import {
  MALFORMED_TOOL_ARGUMENTS_KEY,
  type ModelRequestMessage,
} from '../../src/types/inference.js'

const MODEL = 'gpt-6-astra'

const reasoningItem = {
  type: 'reasoning',
  id: 'rs_1',
  summary: [],
  encrypted_content: 'ciphertext',
}

function history(stateModel: string): ModelRequestMessage[]
{
  return [
    { role: 'system', content: 'base prompt' },
    { role: 'user', content: 'fix a.ts' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_real',
          function: { name: 'read_file', arguments: { path: 'a.ts' } },
        },
      ],
      providerState: {
        provider: 'openai',
        model: stateModel,
        items: [reasoningItem],
      },
    },
    { role: 'tool', tool_name: 'read_file', content: 'file body' },
    { role: 'system', content: '## Git Context' },
  ]
}

test('reasoning replays before its call and outputs pair by call_id', () =>
{
  const { instructions, input } = toOpenAIInput(history(MODEL), MODEL)

  assert.equal(instructions, 'base prompt')
  assert.deepEqual(input, [
    { role: 'user', content: 'fix a.ts' },
    reasoningItem,
    {
      type: 'function_call',
      call_id: 'call_real',
      name: 'read_file',
      arguments: '{"path":"a.ts"}',
    },
    { type: 'function_call_output', call_id: 'call_real', output: 'file body' },
    { role: 'developer', content: '## Git Context' },
  ])
})

test('encrypted reasoning from another model is not replayed', () =>
{
  const { input } = toOpenAIInput(history('gpt-6.1-sol'), MODEL)
  assert.equal(
    input.some((item) => 'type' in item && item.type === 'reasoning'),
    false
  )
})

test('the terminal chunk keeps call ids, cached usage, and reasoning state', () =>
{
  const response = {
    status: 'completed',
    incomplete_details: null,
    output: [
      reasoningItem,
      {
        type: 'function_call',
        call_id: 'call_next',
        name: 'grep',
        arguments: '{"pattern":"TODO"}',
      },
    ],
    usage: {
      input_tokens: 12_000,
      input_tokens_details: { cached_tokens: 11_000, cache_write_tokens: 500 },
      output_tokens: 300,
    },
  } as unknown as Response

  const chunk = finalChunkFrom(response, MODEL)

  assert.equal(chunk.done, true)
  assert.equal(chunk.prompt_eval_count, 12_000)
  assert.equal(chunk.cached_prompt_count, 11_000)
  assert.equal(chunk.cache_write_count, 500)
  assert.equal(chunk.done_reason, undefined)
  assert.deepEqual(chunk.message.tool_calls, [
    {
      id: 'call_next',
      type: 'function',
      function: { name: 'grep', arguments: { pattern: 'TODO' } },
    },
  ])
  assert.deepEqual(chunk.message.providerState, {
    provider: 'openai',
    model: MODEL,
    items: [reasoningItem],
  })
})

const partialCall = {
  type: 'function_call',
  call_id: 'call_1',
  name: 'git_push',
  arguments: '{"remote":"ori',
  status: 'in_progress',
}

function endedResponse(fields: Record<string, unknown>): Response
{
  return {
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [],
    usage: undefined,
    ...fields,
  } as unknown as Response
}

test('failed, unfinished, and filtered responses fail instead of finishing', () =>
{
  for (const [fields, pattern] of [
    [
      {
        status: 'failed',
        error: { code: 'server_error', message: 'The server had an error' },
        output: [partialCall],
      },
      /failed: The server had an error/,
    ],
    [{ status: 'in_progress', output: [partialCall] }, /in_progress/],
    [
      {
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
      },
      /content filter/,
    ],
  ] as const)
  {
    assert.throws(() => finalChunkFrom(endedResponse(fields), MODEL), pattern)
  }
})

test('an output-limit cut reports length and drops the unfinished call', () =>
{
  const chunk = finalChunkFrom(
    endedResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [partialCall],
    }),
    MODEL
  )
  assert.equal(chunk.done_reason, 'length')
  assert.equal(chunk.message.tool_calls, undefined)
})

test('a completed call with malformed arguments never runs', () =>
{
  const response = endedResponse({
    output: [
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'list_files',
        arguments: '{"path":',
        status: 'completed',
      },
    ],
  })
  const [call] = finalChunkFrom(response, MODEL).message.tool_calls ?? []
  assert.deepEqual(Object.keys(call!.function.arguments), [
    MALFORMED_TOOL_ARGUMENTS_KEY,
  ])
  assert.match(
    String(call!.function.arguments[MALFORMED_TOOL_ARGUMENTS_KEY]),
    /malformed arguments for list_files/
  )
})
