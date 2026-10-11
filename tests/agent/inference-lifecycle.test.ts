// tests/agent/inference-lifecycle.test.ts
// mocked stream completion and shared subagent inference contracts

import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Agent, type AgentInferenceClient } from '../../src/agent/agent.js'
import { TurnContextAssembler } from '../../src/agent/request/turn-context.js'
import type { CodeIntelService } from '../../src/lsp/contracts.js'
import { OllamaClient } from '../../src/ollama/client.js'
import { taskTool } from '../../src/tools/task.js'
import type { Tool } from '../../src/tools/tool.js'
import type { ChatRequest } from '../../src/types/inference.js'
import { makeAgentEvents } from '../helpers/agent-harness.js'
import { withFetch } from '../helpers/fetch.js'

const mockCwd = join(tmpdir(), 'coral-inference-mock-only', String(process.pid))

test('incomplete/error streams preserve partial text without completing or executing tools', async (t) =>
{
  t.mock.method(TurnContextAssembler.prototype, 'gatherGit', async () => null)
  const codeIntel: CodeIntelService = {
    async query()
    {
      assert.fail('this stream regression must not query LSP')
    },
    async dispose()
    {},
  }

  for (const scenario of ['eof', 'error', 'cancel'] as const)
  {
    await t.test(scenario, async () =>
    {
      let toolCalls = 0
      const tool: Tool = {
        name: 'read_file',
        description: 'count completed calls',
        parameters: { type: 'object', properties: {} },
        async execute()
        {
          toolCalls++
          return { output: 'tool completed' }
        },
      }
      const controller = new AbortController()
      const agent = new Agent('fake-model', undefined, mockCwd, {
        inferenceClient: new OllamaClient('http://mocked.invalid'),
        tools: [tool],
        permissions: { read_file: 'always_allow' },
        codeIntel,
        numCtx: 8_192,
        verifyEdits: false,
        mcpMode: 'off',
      })
      const errors: Error[] = []
      let completed = 0
      let text = ''
      const partial = {
        message: {
          role: 'assistant',
          content: 'partial answer',
          thinking: 'unfinished thought',
          tool_calls: [{ function: { name: 'read_file', arguments: {} } }],
        },
        done: false,
      }
      const lines = [partial]
      const body =
        lines.map((line) => JSON.stringify(line)).join('\n') +
        (scenario === 'error' ? '\n{"error":"model runner failed"}' : '')
      try
      {
        await withFetch(
          async () => new Response(body),
          () =>
            agent.run(
              'inspect this request',
              makeAgentEvents({
                onToken(token)
                {
                  text += token
                  if (scenario === 'cancel') controller.abort()
                },
                onDone()
                {
                  completed++
                },
                onError(error)
                {
                  errors.push(error)
                },
              }),
              controller.signal
            )
        )

        assert.equal(text, 'partial answer')
        assert.equal(toolCalls, 0)
        const saved = agent.getMessages().at(-1)
        assert.equal(saved?.role, 'assistant')
        assert.equal(saved?.content, 'partial answer')
        assert.equal(saved?.thinking, 'unfinished thought')
        assert.equal(saved?.tool_calls, undefined)
        if (scenario === 'cancel')
        {
          assert.equal(completed, 1)
          assert.deepEqual(errors, [])
        }
        else
        {
          assert.equal(completed, 0)
          assert.equal(errors.length, 1)
          assert.match(
            errors[0]!.message,
            scenario === 'eof'
              ? /ended before completion/
              : /model runner failed/
          )
        }
      }
      finally
      {
        await agent.dispose()
      }
    })
  }
})

test('the default task child shares parent inference and leaves borrowed resources usable', async (t) =>
{
  t.mock.method(TurnContextAssembler.prototype, 'gatherGit', async () => null)
  let borrowedDisposals = 0
  const codeIntel: CodeIntelService = {
    async query()
    {
      return 'borrowed LSP remains available'
    },
    async dispose()
    {
      borrowedDisposals++
    },
  }
  const requests: ChatRequest[] = []
  const client: AgentInferenceClient = {
    startKeepAlive()
    {},
    async showModel()
    {
      assert.fail('the pinned parent context must reach the child')
    },
    async listModels()
    {
      assert.fail('the pinned parent context must reach the child')
    },
    async *chatStream(request)
    {
      requests.push(request)
      const call = requests.length
      if (call === 1)
      {
        yield {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'task',
                  arguments: { prompt: 'inspect child' },
                },
              },
            ],
          },
          done: true,
        }
        return
      }
      yield {
        message: {
          role: 'assistant',
          content:
            call === 2 ? 'child report' : call === 3 ? 'done' : 'still usable',
        },
        done: true,
      }
    },
  }
  const parent = new Agent('fake-model', undefined, mockCwd, {
    inferenceClient: client,
    tools: [taskTool],
    permissions: { task: 'always_allow' },
    codeIntel,
    numCtx: 8_192,
    verifyEdits: false,
    mcpMode: 'off',
  })
  try
  {
    await withFetch(
      async () => assert.fail('the default child must use the injected client'),
      async () =>
      {
        await parent.run('delegate research', makeAgentEvents())
        assert.equal(requests.length, 3)
        assert.ok(
          requests[1]!.messages.some(
            (message) => message.content === 'inspect child'
          )
        )
        assert.ok(
          requests[2]!.messages.some(
            (message) =>
              message.role === 'tool' && message.content === 'child report'
          )
        )
        assert.equal(borrowedDisposals, 0)
        assert.equal(
          await codeIntel.query({
            operation: 'diagnostics',
            path: 'unused.ts',
          }),
          'borrowed LSP remains available'
        )
        await parent.run('continue here', makeAgentEvents())
        assert.equal(requests.length, 4)
        assert.equal(parent.getMessages().at(-1)?.content, 'still usable')
      }
    )
  }
  finally
  {
    await parent.dispose()
  }
  assert.equal(borrowedDisposals, 0)
})
