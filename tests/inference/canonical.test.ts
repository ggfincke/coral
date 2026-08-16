// tests/inference/canonical.test.ts
// session persist writes canonical model ids; resume compares via ModelRef

import { strict as assert } from 'node:assert'
import { after, beforeEach, test } from 'node:test'
import type { AgentInferenceClient } from '../../src/agent/inference-client.js'
import {
  buildPrimaryAgent,
  persistAgentSession,
} from '../../src/tui/session/agent-session.js'
import { createSession, loadSession } from '../../src/session/store.js'
import { modelRefsEqual, parseModelRef } from '../../src/inference/model-ref.js'
import { captureAgentsHome } from '../helpers/agents-home.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()
const restoreAgentsHome = captureAgentsHome()

const stubClient: AgentInferenceClient = {
  startKeepAlive()
  {},
  async showModel()
  {
    return { contextLength: 8_192, architecture: 'gemma4' }
  },
  async listModels()
  {
    return [
      {
        name: 'gemma4:31b-mlx',
        model: 'gemma4:31b-mlx',
        size: 1,
        modified_at: '',
      },
    ]
  },
  async *chatStream()
  {},
}

beforeEach(async () =>
{
  process.env.CORAL_HOME = await tempDir('coral-canonical-session-')
  process.env.AGENTS_HOME = await tempDir('coral-canonical-agents-home-')
})

after(async () =>
{
  restoreCoralHome()
  restoreAgentsHome()
  await cleanup()
})

test('buildPrimaryAgent persists canonical ollama refs', async () =>
{
  const cwd = await tempDir('coral-canonical-cwd-')
  const agent = buildPrimaryAgent({
    model: 'gemma4:31b-mlx',
    host: 'http://localhost:11434',
    cwd,
    think: true,
    mcpMode: 'off',
    mcpConfig: { servers: [], issues: [] },
    inferenceClient: stubClient,
  })
  assert.equal(agent.getModel(), 'ollama:gemma4:31b-mlx')
  const meta = persistAgentSession(agent, null)
  assert.ok(meta)
  const loaded = loadSession(meta!.id)
  assert.equal(loaded?.meta.model, 'ollama:gemma4:31b-mlx')
  assert.equal(modelRefsEqual(loaded!.meta.model, 'gemma4:31b-mlx'), true)
  await agent.dispose()
})

test('legacy session colon tags hydrate as explicit Ollama refs', async () =>
{
  const cwd = await tempDir('coral-legacy-session-cwd-')
  const meta = createSession('mistral:latest', cwd, [
    { role: 'system', content: 'system' },
  ])

  assert.equal(loadSession(meta.id)?.meta.model, 'ollama:mistral:latest')
  assert.throws(() => parseModelRef('mistral:latest'), /Unknown model backend/)
})
