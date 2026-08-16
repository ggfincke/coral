// tests/inference/model-ref.test.ts
// closed-set ModelRef parse, equality, and listed-name matching

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  canonicalListedName,
  canonicalizePersistedModelRef,
  formatCanonical,
  matchListedModel,
  modelRefsEqual,
  parseModelRef,
  remainderForBackend,
  tryParseModelRef,
} from '../../src/inference/model-ref.js'

test('bare names and Ollama -mlx tags are ollama refs', () =>
{
  assert.deepEqual(parseModelRef('gemma4'), {
    backend: 'ollama',
    model: 'gemma4',
    canonical: 'ollama:gemma4',
  })
  assert.deepEqual(parseModelRef('gemma4:31b-mlx'), {
    backend: 'ollama',
    model: 'gemma4:31b-mlx',
    canonical: 'ollama:gemma4:31b-mlx',
  })
  assert.deepEqual(parseModelRef('ollama:gemma4:31b-mlx'), {
    backend: 'ollama',
    model: 'gemma4:31b-mlx',
    canonical: 'ollama:gemma4:31b-mlx',
  })
})

test('mlx: prefix selects the mlx backend', () =>
{
  assert.deepEqual(parseModelRef('mlx:qwen3-coder'), {
    backend: 'mlx',
    model: 'qwen3-coder',
    canonical: 'mlx:qwen3-coder',
  })
})

test('unknown letter-only prefixes fail closed regardless of tag shape', () =>
{
  assert.throws(() => parseModelRef('foo:bar'), /Unknown model backend "foo"/)
  assert.throws(() => parseModelRef('foo:latest'), /Unknown model backend/)
  assert.throws(() => parseModelRef('cuda:model2'), /Unknown model backend/)
  assert.throws(() => parseModelRef('openai:gpt-5'), /Unknown model backend/)
  assert.equal(tryParseModelRef('foo:bar'), undefined)
  assert.throws(() => parseModelRef('mlx:'), /missing a name/)
  assert.throws(() => parseModelRef(''), /nonempty/)
})

test('letter-only Ollama tag names require an explicit backend', () =>
{
  assert.throws(() => parseModelRef('mistral:latest'), /ollama:mistral:latest/)
  assert.deepEqual(parseModelRef('ollama:mistral:latest'), {
    backend: 'ollama',
    model: 'mistral:latest',
    canonical: 'ollama:mistral:latest',
  })
})

test('persisted pre-backend colon tags migrate without weakening parsing', () =>
{
  assert.equal(
    canonicalizePersistedModelRef('mistral:latest'),
    'ollama:mistral:latest'
  )
  assert.equal(
    canonicalizePersistedModelRef('mlx:qwen3-coder'),
    'mlx:qwen3-coder'
  )
  assert.throws(() => parseModelRef('mistral:latest'), /Unknown model backend/)
})

test('resume matching compares via canonical form, not raw strings', () =>
{
  assert.equal(modelRefsEqual('gemma4:31b-mlx', 'ollama:gemma4:31b-mlx'), true)
  assert.equal(modelRefsEqual('mlx:qwen3-coder', 'qwen3-coder'), false)
  assert.equal(
    matchListedModel('gemma4:31b-mlx', ['ollama:gemma4:31b-mlx']).exact,
    'ollama:gemma4:31b-mlx'
  )
  assert.deepEqual(
    matchListedModel('mlx:qwen', ['mlx:qwen3-coder', 'ollama:gemma4'])
      .prefixMatches,
    ['mlx:qwen3-coder']
  )
  assert.throws(() => matchListedModel('foo:bar', ['ollama:gemma4']))
})

test('listed names and remainders stay backend-specific', () =>
{
  assert.equal(canonicalListedName('qwen3-coder', 'mlx'), 'mlx:qwen3-coder')
  assert.equal(
    remainderForBackend('ollama:gemma4:31b-mlx', 'ollama'),
    'gemma4:31b-mlx'
  )
  assert.equal(formatCanonical('mlx', 'qwen3-coder'), 'mlx:qwen3-coder')
  assert.throws(() => remainderForBackend('mlx:qwen3-coder', 'ollama'))
})
