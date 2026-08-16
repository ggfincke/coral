// tests/protocol/fixtures.test.ts
// load golden protocol fixtures through generated Ajv validators

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  validateChatProtocol,
  validateCoralExecFrame,
  validateEmbeddingProtocol,
  validateEnvelope,
  validateHandshakeFrame,
  validateModelProtocol,
  type ProtocolValidation,
} from '../../src/protocol/generated/validators.js'

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../protocol/fixtures'
)

const EXEC_EVENT_TYPES = [
  'init',
  'assistant_delta',
  'thinking_delta',
  'tool_call',
  'tool_result',
  'approval_rejected',
  'mcp_launch_rejected',
  'doom_loop_stopped',
  'usage',
  'done',
  'error',
  'result',
] as const

function validatorFor(
  filename: string
): (value: unknown) => ProtocolValidation
{
  const prefix = filename.split('-')[0]
  switch (prefix)
  {
    case 'exec':
      return validateCoralExecFrame
    case 'envelope':
      return validateEnvelope
    case 'handshake':
      return validateHandshakeFrame
    case 'chat':
      return validateChatProtocol
    case 'model':
      return validateModelProtocol
    case 'embedding':
      return validateEmbeddingProtocol
    default:
      throw new Error(`no validator mapped for fixture ${filename}`)
  }
}

function loadJson(path: string): unknown
{
  return JSON.parse(readFileSync(path, 'utf8'))
}

function listFixtures(kind: 'valid' | 'invalid'): string[]
{
  return readdirSync(join(fixturesRoot, kind))
    .filter((name) => name.endsWith('.json'))
    .sort()
}

test('valid protocol fixtures are accepted by generated Ajv validators', () =>
{
  const files = listFixtures('valid')
  assert.ok(files.length > 0)
  const seenExecTypes = new Set<string>()
  let sawBareResult = false
  let sawEmptyResponse = false

  for (const filename of files)
  {
    const path = join(fixturesRoot, 'valid', filename)
    const value = loadJson(path)
    const result = validatorFor(filename)(value)
    assert.equal(
      result.valid,
      true,
      `${filename} should be valid: ${result.errors ?? 'no Ajv errors'}`
    )
    if (
      filename.startsWith('exec-') &&
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      typeof value.type === 'string'
    )
    {
      seenExecTypes.add(value.type)
    }
    if (filename === 'exec-result-object.json') sawBareResult = true
    if (filename === 'exec-result-empty.json') sawEmptyResponse = true
  }

  for (const type of EXEC_EVENT_TYPES)
  {
    assert.ok(
      seenExecTypes.has(type),
      `missing valid fixture for exec type ${type}`
    )
  }
  assert.equal(sawBareResult, true)
  assert.equal(sawEmptyResponse, true)
})

test('invalid protocol fixtures are rejected by generated Ajv validators', () =>
{
  const files = listFixtures('invalid')
  assert.ok(files.includes('exec-unknown-type.json'))
  assert.ok(files.includes('exec-missing-run-id.json'))
  assert.ok(files.includes('exec-wrong-usage-shape.json'))

  for (const filename of files)
  {
    const path = join(fixturesRoot, 'invalid', filename)
    const value = loadJson(path)
    const result = validatorFor(filename)(value)
    assert.equal(result.valid, false, `${filename} should be invalid`)
  }
})

test('generated Ajv validators reject non-finite protocol numbers', () =>
{
  assert.equal(
    validateModelProtocol({ contextLength: Number.POSITIVE_INFINITY }).valid,
    false
  )
  assert.equal(
    validateEmbeddingProtocol({ vectors: [[Number.NaN]] }).valid,
    false
  )
})
