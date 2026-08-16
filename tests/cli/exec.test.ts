// tests/cli/exec.test.ts
// verify headless capability profiles and structured execution evidence

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import type { AgentInferenceClient } from '../../src/agent/agent.js'
import { resolveHeadlessProfile, runCoralExec } from '../../src/cli/exec.js'
import { captureAgentsHome } from '../helpers/agents-home.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()
const restoreAgentsHome = captureAgentsHome()

after(async () =>
{
  restoreCoralHome()
  restoreAgentsHome()
  await cleanup()
})

test('headless profiles exclude nested and Git-mutation capabilities', () =>
{
  const readOnly = resolveHeadlessProfile('read-only')
  const readNames = readOnly.tools.map((tool) => tool.name)
  assert.ok(readNames.includes('read_file'))
  assert.ok(readNames.includes('git_status'))
  assert.ok(readNames.includes('skill'))
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
  const dir = await tempDir('coral-exec-')
  process.env.CORAL_HOME = await tempDir('coral-exec-home-')
  process.env.AGENTS_HOME = await tempDir('coral-exec-agents-home-')
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
  assert.equal(result.model, 'ollama:fake-model')
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
})

test('exec mlx model without a working worker names the uv install command', async () =>
{
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const dir = await tempDir('coral-exec-mlx-missing-')
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/cli/main.tsx',
      'exec',
      '-m',
      'mlx:foo',
      'hi',
      '--cwd',
      dir,
      '--output-format',
      'json',
      '--no-mcp',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CORAL_HOME: await tempDir('coral-exec-mlx-home-'),
        AGENTS_HOME: await tempDir('coral-exec-mlx-agents-home-'),
        CORAL_PYTHON: '/nonexistent/coral-python-missing',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const code = await new Promise<number | null>((resolveExit, reject) =>
  {
    const timer = setTimeout(() =>
    {
      child.kill('SIGKILL')
      reject(new Error('exec mlx-missing worker timed out'))
    }, 20_000)
    child.once('error', reject)
    child.once('close', (exitCode) =>
    {
      clearTimeout(timer)
      resolveExit(exitCode)
    })
  })
  const errText = Buffer.concat(stderr).toString('utf8')
  const outText = Buffer.concat(stdout).toString('utf8')
  assert.notEqual(code, 0)
  assert.match(
    `${errText}\n${outText}`,
    /uv sync --project packages\/coral-backend/
  )
})
