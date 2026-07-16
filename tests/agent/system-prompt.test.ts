// tests/agent/system-prompt.test.ts
// regression tests for system prompt project context

import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildSystemPrompt } from '../../src/agent/system-prompt.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

test('buildSystemPrompt includes lightweight project context', async () =>
{
  const dir = await tempDir('coral-prompt-')

  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'README.md'), '# Fixture\n', 'utf-8')
  await writeFile(
    join(dir, 'package.json'),
    '{\n  "name": "fixture"\n}\n',
    'utf-8'
  )

  const fixtureTool = {
    name: 'demo_tool',
    description: 'Demonstrate parameter rendering.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path' },
        mode: { enum: ['fast', 'safe'] },
        lines: { type: 'array', items: { type: 'number' } },
        anything: true,
      },
      required: ['path'],
    },
    execute: async () => ({ output: '' }),
  }
  const bareTool = {
    name: 'bare_tool',
    description: 'No parameters at all.',
    parameters: { type: 'object' },
    execute: async () => ({ output: '' }),
  }

  const prompt = buildSystemPrompt({
    model: 'qwen3-coder:latest',
    cwd: dir,
    tools: [fixtureTool, bareTool],
  })

  assert.match(prompt, /Running model: qwen3-coder:latest/)
  assert.match(prompt, /## Project Context/)
  assert.match(prompt, /Project name: coral-prompt-/)
  assert.match(prompt, /Top-level entries: package\.json, README\.md, src\//)

  // model-facing parameter lines render type, requiredness, & description
  assert.match(prompt, /- path: string \(required\) — file path/)
  assert.match(prompt, /- mode: enum \(optional\)/)
  assert.match(prompt, /- lines: array \(optional\)/)
  assert.match(prompt, /- anything: any \(optional\)/)
  // zero-parameter tools get no dangling header
  assert.match(
    prompt,
    /\*\*bare_tool\*\*: No parameters at all\.\n {2}Parameters: \(none\)/
  )
})

test('buildSystemPrompt applies the project context budget', async () =>
{
  const dir = await tempDir('coral-prompt-budget-')
  await writeFile(join(dir, '.coral.md'), 'x'.repeat(600), 'utf-8')

  const prompt = buildSystemPrompt({
    model: 'qwen3-coder:latest',
    cwd: dir,
    tools: [],
    projectContextBudget: 300,
  })

  assert.match(prompt, /Loaded Project Context/)
  assert.match(prompt, /truncated to fit budget/)
  assert.ok(!prompt.includes('x'.repeat(600)))
})
