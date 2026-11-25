// tests/providers/hosted-config.test.ts
// verify hosted context ceilings never fall below a usable window

import { strict as assert } from 'node:assert'
import { utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MIN_NUM_CTX } from '../../src/config/context.js'
import {
  DEFAULT_HOSTED_MAX_CONTEXT_TOKENS,
  resolveHostedSettings,
} from '../../src/providers/config.js'

test('fractional and sub-minimum maxContextTokens stay usable', async (t) =>
{
  const previousKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'test-key'
  t.after(() =>
  {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
  })
  const path = join(homedir(), '.coral.json')

  for (const [index, [configured, expected]] of [
    [0.5, DEFAULT_HOSTED_MAX_CONTEXT_TOKENS],
    [100, MIN_NUM_CTX],
  ].entries())
  {
    writeFileSync(
      path,
      JSON.stringify({
        providers: { anthropic: { maxContextTokens: configured } },
      })
    )
    // the config cache keys on mtime, so each value gets its own
    const stamp = new Date(Date.now() + index * 10_000)
    utimesSync(path, stamp, stamp)
    const settings = await resolveHostedSettings('anthropic')
    assert.equal(settings.maxContextTokens, expected, String(configured))
    assert.equal(settings.apiKeySource, 'ANTHROPIC_API_KEY')
  }
})
