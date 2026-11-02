// tests/providers/model-ref.test.ts
// verify hosted prefixes route while every Ollama name stays local

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseModelRef } from '../../src/providers/model-ref.js'

test('exact hosted prefixes route to their provider with the native id', () =>
{
  assert.deepEqual(parseModelRef('anthropic/claude-opus-5-5'), {
    provider: 'anthropic',
    name: 'claude-opus-5-5',
  })
  assert.deepEqual(parseModelRef('openai/gpt-6-astra'), {
    provider: 'openai',
    name: 'gpt-6-astra',
  })
})

test('Ollama names, tags, and other namespaces stay on Ollama untouched', () =>
{
  for (const model of [
    'gemma4:31b-mlx',
    'hf.co/user/model:Q4_K_M',
    'library/qwen3.6:35b',
    'anthropic',
    'anthropic/',
    'openai-ish/model',
  ])
  {
    assert.deepEqual(parseModelRef(model), { provider: 'ollama', name: model })
  }
})
