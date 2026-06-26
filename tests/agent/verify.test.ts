// tests/agent/verify.test.ts
// post-edit self-check prompt building & verdict parsing

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildVerifyPrompt,
  buildVerifyReprompt,
  parseVerifyVerdict,
} from '../../src/agent/verify.js'

test('buildVerifyPrompt carries the request, diffs, & verdict instruction', () =>
{
  const prompt = buildVerifyPrompt('Add a retry to fetchUser', [
    '--- a/user.ts\n+++ b/user.ts\n@@ retry @@',
  ])
  assert.ok(prompt.includes('Add a retry to fetchUser'))
  assert.ok(prompt.includes('user.ts'))
  assert.ok(prompt.includes('VERDICT: PASS'))
})

test('buildVerifyReprompt carries the reason & invites a justification', () =>
{
  const msg = buildVerifyReprompt('missed the null check')
  assert.ok(msg.includes('missed the null check'))
  assert.ok(/fix/i.test(msg))
  // lets the model push back on a false-positive FAIL instead of forcing an edit
  assert.ok(/correct/i.test(msg))
})

test('buildVerifyReprompt falls back to a generic prompt without a reason', () =>
{
  const msg = buildVerifyReprompt()
  assert.ok(msg.length > 0)
  assert.ok(/fix/i.test(msg))
})

test('parses a PASS verdict', () =>
{
  const result = parseVerifyVerdict('Looks correct.\nVERDICT: PASS', 2)
  assert.equal(result.status, 'pass')
  assert.equal(result.reason, undefined)
  assert.equal(result.editCount, 2)
})

test('parses a FAIL verdict & its reason across dash styles', () =>
{
  const dash = parseVerifyVerdict('VERDICT: FAIL - missed the null check', 1)
  assert.equal(dash.status, 'fail')
  assert.equal(dash.reason, 'missed the null check')

  const emDash = parseVerifyVerdict('VERDICT: FAIL — wrong file edited', 1)
  assert.equal(emDash.status, 'fail')
  assert.equal(emDash.reason, 'wrong file edited')
})

test('scans from the end so trailing verdict wins', () =>
{
  const text = [
    'I considered VERDICT: PASS earlier but reconsidered.',
    'After re-reading:',
    'VERDICT: FAIL - off-by-one in the loop',
  ].join('\n')
  const result = parseVerifyVerdict(text, 1)
  assert.equal(result.status, 'fail')
  assert.equal(result.reason, 'off-by-one in the loop')
})

test('no verdict line is inconclusive', () =>
{
  const result = parseVerifyVerdict('I am not sure about this change.', 3)
  assert.equal(result.status, 'unknown')
  assert.equal(result.editCount, 3)
})
