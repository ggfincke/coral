// tests/cli/boundaries.test.ts
// protect CLI discovery, preflight output, bounded input, and cancellation

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCliArgs } from '../../src/cli/args.js'
import { readPromptStream } from '../../src/cli/exec.js'

const cli = (args: string[], input = '') =>
  spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/main.tsx', ...args],
    { encoding: 'utf8', input }
  )

test('root discovery and shared options work before runtime startup, including non-TTY errors', () =>
{
  for (const args of [
    ['--help'],
    ['help', 'exec'],
    ['exec', '--help'],
    ['exec', '--version'],
  ])
  {
    const result = cli(args)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.trim())
  }
  assert.match(cli(['--help']).stdout, /exec/)
  const parsed = parseCliArgs([
    '-C',
    '/tmp',
    '--no-think',
    'exec',
    '-m',
    'fixture',
    '--host',
    'http://localhost:11434',
    'prompt',
  ])
  assert.equal(parsed.kind, 'exec')
  if (parsed.kind === 'exec')
  {
    assert.equal(parsed.options.cwd, '/tmp')
    assert.equal(parsed.options.think, false)
    assert.equal(parsed.options.model, 'fixture')
    assert.equal(parsed.options.prompt, 'prompt')
  }
  const interactive = cli(['-m', 'fixture'])
  assert.equal(interactive.status, 1)
  assert.match(interactive.stderr, /requires terminal stdin and stdout/)
  assert.equal(cli(['exec', '--unknown']).status, 1)
})

test('parsed input failures emit zero-usage structured results and atomic result files', () =>
{
  const dir = mkdtempSync(join(tmpdir(), 'coral-cli-boundary-'))
  try
  {
    const file = join(dir, 'result.json')
    const result = cli([
      'exec',
      '-m',
      'fixture',
      '--cwd',
      join(dir, 'missing'),
      '--output-format',
      'json',
      '--result-file',
      file,
      'prompt',
    ])
    assert.equal(result.status, 2)
    const value = JSON.parse(result.stdout)
    assert.equal(value.version, 1)
    assert.equal(value.status, 'failed')
    assert.equal(value.usage.prompt_tokens, 0)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), value)
    const unwritable = cli([
      'exec',
      '-m',
      'fixture',
      '--output-format',
      'json',
      '--result-file',
      dir,
    ])
    assert.equal(unwritable.status, 1)
    assert.match(
      JSON.parse(unwritable.stdout).error,
      /failed to write result file/
    )

    for (const [args, input, error] of [
      [['--prompt-file', '-'], '', /nonempty/],
      [['--prompt-file', '-'], 'x'.repeat(1_048_577), /exceeds/],
      [['--prompt-file', '-', 'conflict'], 'stdin', /not both/],
      [['--host', 'invalid', 'prompt'], '', /Invalid Ollama/],
    ] as const)
    {
      const failure = cli(
        ['exec', '-m', 'fixture', '--output-format', 'stream-json', ...args],
        input
      )
      assert.equal(failure.status, 2, failure.stderr)
      const event = JSON.parse(failure.stdout)
      assert.equal(event.type, 'result')
      assert.match(event.error, error)
    }
  }
  finally
  {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stdin reading is bounded incrementally and aborts without waiting for EOF', async () =>
{
  const valid = new PassThrough()
  const text = readPromptStream(valid)
  valid.end('hello stdin')
  assert.equal(await text, 'hello stdin')
  const large = new PassThrough()
  const oversized = readPromptStream(large)
  large.write(Buffer.alloc(1_048_577))
  await assert.rejects(oversized, /exceeds/)
  assert.equal(large.listenerCount('data'), 0)
  const waiting = new PassThrough()
  const controller = new AbortController()
  const cancelled = readPromptStream(waiting, controller.signal)
  controller.abort()
  await assert.rejects(cancelled, /cancelled/)
  assert.equal(waiting.listenerCount('data'), 0)
})
