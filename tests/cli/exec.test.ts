// tests/cli/exec.test.ts
// verify headless capability profiles and structured execution evidence

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentInferenceClient } from '../../src/agent/agent.js'
import { resolveHeadlessProfile, runCoralExec } from '../../src/cli/exec.js'

test('headless profiles exclude nested and Git-mutation capabilities', () =>
{
  const readOnly = resolveHeadlessProfile('read-only')
  const readNames = readOnly.tools.map((tool) => tool.name)
  assert.ok(readNames.includes('read_file'))
  assert.ok(readNames.includes('git_status'))
  assert.equal(readNames.includes('write_file'), false)
  assert.equal(readNames.includes('bash'), false)
  assert.equal(readNames.includes('task'), false)

  const workspaceWrite = resolveHeadlessProfile('workspace-write')
  const writeNames = workspaceWrite.tools.map((tool) => tool.name)
  assert.ok(writeNames.includes('write_file'))
  assert.ok(writeNames.includes('edit_file'))
  assert.ok(writeNames.includes('bash'))
  assert.equal(writeNames.includes('task'), false)
  assert.equal(writeNames.includes('git_commit'), false)
  assert.equal(writeNames.includes('git_push'), false)
  assert.ok(
    Object.values(workspaceWrite.permissions).every(
      (policy) => policy === 'always_allow'
    )
  )
})

test('headless execution emits JSONL and atomically writes its final result', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-exec-'))
  const resultFile = join(dir, 'artifacts', 'result.json')
  const stdout: string[] = []
  const stderr: string[] = []
  const inferenceClient: AgentInferenceClient = {
    startKeepAlive()
    {},
    async showModel()
    {
      return { contextLength: 8_192, architecture: 'gemma' }
    },
    async listModels()
    {
      return []
    },
    async *chatStream()
    {
      yield {
        message: {
          role: 'assistant',
          content:
            '{"summary":"done","assumptions":[],"risks":[],"follow_ups":[]}',
        },
        done: true,
        prompt_eval_count: 12,
        eval_count: 8,
      }
    },
  }

  try
  {
    const result = await runCoralExec(
      {
        prompt: 'inspect the repository',
        cwd: dir,
        model: 'fake-model',
        host: 'http://localhost:11434',
        permissionProfile: 'read-only',
        outputFormat: 'stream-json',
        resultFile,
        mcp: false,
      },
      {
        inferenceClient,
        createRunId: () => 'run-fixture',
        writeStdout: (text) => stdout.push(text),
        writeStderr: (text) => stderr.push(text),
      }
    )

    assert.equal(result.status, 'completed')
    assert.equal(result.run_id, 'run-fixture')
    assert.equal(result.usage.prompt_tokens, 12)
    assert.equal(result.usage.completion_tokens, 8)
    assert.deepEqual(stderr, [])
    assert.deepEqual(JSON.parse(await readFile(resultFile, 'utf-8')), result)
    const events = stdout
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.deepEqual(
      events.map((event) => event.type),
      ['init', 'assistant_delta', 'usage', 'done', 'result']
    )
    assert.equal(events.at(-1)?.status, 'completed')
  }
  finally
  {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tool-free generation stays ephemeral and reports inference failure and cancellation', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-exec-none-'))
  const home = process.env.CORAL_HOME
  process.env.CORAL_HOME = join(dir, 'home')
  try
  {
    for (const mode of ['complete', 'fail', 'cancel'])
    {
      const abort = new AbortController()
      const result = await runCoralExec(
        {
          prompt: 'generate a title',
          cwd: dir,
          model: 'fixture',
          host: 'http://ollama.test',
          permissionProfile: 'none',
          outputFormat: 'json',
          mcp: true,
        },
        {
          writeStdout()
          {},
          writeStderr()
          {},
          inferenceClient: {
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
            async *chatStream(request)
            {
              assert.deepEqual(request.tools, [])
              if (mode === 'fail') throw new Error('inference unavailable')
              if (mode === 'cancel') abort.abort()
              yield {
                message: { role: 'assistant', content: 'title' },
                done: true,
              }
            },
          },
        },
        abort.signal
      )
      assert.equal(
        result.status,
        mode === 'complete'
          ? 'completed'
          : mode === 'fail'
            ? 'failed'
            : 'cancelled'
      )
    }
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(join(process.env.CORAL_HOME!, 'sessions')), false)
  }
  finally
  {
    if (home === undefined) delete process.env.CORAL_HOME
    else process.env.CORAL_HOME = home
    await rm(dir, { recursive: true, force: true })
  }
})
