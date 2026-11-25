// tests/agent/edit-self-check.test.ts
// post-edit self-check outcomes the Agent reports to its host

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { VerificationResult } from '../../src/agent/loop/edit-verification.js'
import type { Tool } from '../../src/tools/tool.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { makeAgentEvents, makeFakeAgent } from '../helpers/agent-harness.js'

const { tempDir } = makeTempDirPool()

test('a self-check that errors reports an unknown verdict', async () =>
{
  const dir = await tempDir('coral-self-check-error-')
  const tool: Tool = {
    name: 'read_file',
    description: 'diff-producing test tool',
    parameters: { type: 'object', properties: {} },
    async execute()
    {
      return { output: 'changed', diff: '--- a/x.ts\n+++ b/x.ts\n@@\n-a\n+b\n' }
    },
  }
  const { agent } = makeFakeAgent(
    dir,
    [
      [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                type: 'function',
                function: { name: 'read_file', arguments: {} },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { role: 'assistant', content: 'done' }, done: true }],
    ],
    {
      tools: [tool],
      verifyEdits: true,
      async readOnlySubagentRunner()
      {
        return { text: '', error: 'prompt too large', aborted: false }
      },
    }
  )

  const verdicts: VerificationResult[] = []
  const outcome = await agent.run(
    'edit x',
    makeAgentEvents({
      onVerification(result)
      {
        verdicts.push(result)
      },
    })
  )

  assert.equal(outcome.status, 'completed')
  assert.equal(verdicts.length, 1)
  assert.equal(verdicts[0]!.status, 'unknown')
  assert.equal(verdicts[0]!.editCount, 1)
  await agent.dispose()
})
