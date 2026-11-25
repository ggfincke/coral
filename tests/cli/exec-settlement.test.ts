// tests/cli/exec-settlement.test.ts
// prove exec settles from the Agent outcome and keeps configured denies

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentInferenceClient } from '../../src/agent/agent.js'
import { runCoralExec, type CoralExecOptions } from '../../src/cli/exec.js'

// client whose first reply calls one tool; later replies repeat it or finish
function toolCallClient(
  name: string,
  args: Record<string, unknown>,
  repeat: boolean
): AgentInferenceClient
{
  let requests = 0
  return {
    startKeepAlive()
    {},
    async listModels()
    {
      return []
    },
    async showModel()
    {
      return { contextLength: 8192, architecture: 'gemma' }
    },
    async *chatStream()
    {
      requests++
      yield repeat || requests === 1
        ? {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name, arguments: args } }],
            },
            done: true,
          }
        : { message: { role: 'assistant', content: 'done' }, done: true }
    },
  }
}

async function runInTempDir(
  options: Pick<CoralExecOptions, 'permissionProfile'>,
  inferenceClient: AgentInferenceClient,
  prepare: (dir: string) => Promise<void> = async () =>
  {}
)
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-exec-settlement-'))
  const stdout: string[] = []
  try
  {
    await prepare(dir)
    const result = await runCoralExec(
      {
        prompt: 'work',
        think: false,
        cwd: dir,
        model: 'fixture',
        host: 'http://ollama.test',
        outputFormat: 'stream-json',
        mcp: false,
        ...options,
      },
      {
        inferenceClient,
        writeStdout: (text) => stdout.push(text),
        writeStderr()
        {},
      }
    )
    const events = stdout
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    return { result, events }
  }
  finally
  {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a declined doom loop settles as doom_loop_stopped, not completed', async () =>
{
  const { result, events } = await runInTempDir(
    { permissionProfile: 'read-only' },
    toolCallClient('read_file', { path: 'missing.txt' }, true)
  )

  assert.equal(result.status, 'doom_loop_stopped')
  assert.match(result.error ?? '', /doom-loop guard/)
  assert.ok(events.some((event) => event.type === 'doom_loop_stopped'))
  assert.equal(events.at(-1)?.status, 'doom_loop_stopped')
})

test('a configured always_deny wins over the workspace-write profile', async () =>
{
  const { result, events } = await runInTempDir(
    { permissionProfile: 'workspace-write' },
    toolCallClient('bash', { command: 'echo hi' }, false),
    (dir) =>
      writeFile(
        join(dir, '.coral.json'),
        JSON.stringify({ permissions: { bash: 'always_deny' } })
      )
  )

  assert.equal(result.status, 'completed')
  const bashResult = events.find(
    (event) => event.type === 'tool_result' && event.name === 'bash'
  )
  assert.match(String(bashResult?.error), /denied by permission policy/)
})
