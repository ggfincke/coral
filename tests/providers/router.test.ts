// tests/providers/router.test.ts
// verify local-only model listings never wait on hosted providers

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AgentInferenceClient } from '../../src/agent/inference-client.js'
import { RoutingInferenceClient } from '../../src/providers/router.js'

test('a local-only listing returns while a hosted loader never resolves', async () =>
{
  const local = [{ name: 'qwen3:32b', model: 'qwen3:32b', size: 20 }]
  const ollama = {
    startKeepAlive()
    {},
    async showModel()
    {
      return { contextLength: 32_768 }
    },
    async listModels()
    {
      return local
    },
    async *chatStream()
    {},
  } as unknown as AgentInferenceClient
  let hostedLoads = 0
  const stalled = () =>
  {
    hostedLoads++
    return new Promise<AgentInferenceClient>(() => undefined)
  }
  const router = new RoutingInferenceClient(undefined, {
    ollama,
    loaders: { anthropic: stalled, openai: stalled },
    hasCredentials: () => true,
  })

  assert.deepEqual(
    await router.listModels(undefined, { localOnly: true }),
    local
  )
  assert.equal(hostedLoads, 0)
})
