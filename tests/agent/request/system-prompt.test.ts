// tests/agent/request/system-prompt.test.ts
// system prompt project context & active capability tests

import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildSystemPrompt } from '../../../src/agent/request/system-prompt.js'
import {
  builtInToolRegistrations,
  ToolCatalog,
} from '../../../src/tools/catalog.js'
import { allTools, subagentTools } from '../../../src/tools/registry.js'
import type { Tool } from '../../../src/tools/tool.js'
import { makeTempDirPool } from '../../helpers/temp.js'

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

  const bareTool: Tool = {
    name: 'bare_tool',
    description: 'No parameters at all.',
    parameters: { type: 'object' },
    execute: async () => ({ output: '' }),
  }

  const prompt = buildSystemPrompt({
    model: 'qwen3-coder:latest',
    cwd: dir,
    catalog: new ToolCatalog({ trustedTools: [bareTool] }),
  })

  assert.match(prompt, /Running model: qwen3-coder:latest/)
  assert.match(prompt, /## Project Context/)
  assert.match(prompt, /Project name: coral-prompt-/)
  assert.match(prompt, /Top-level entries: package\.json, README\.md, src\//)

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
    catalog: new ToolCatalog({ trustedTools: [] }),
    projectContextBudget: 300,
  })

  assert.match(prompt, /Loaded Project Context/)
  assert.match(prompt, /truncated to fit budget/)
  assert.ok(!prompt.includes('x'.repeat(600)))
})

test('loaded project context cannot expand a restricted tool catalog', async () =>
{
  const dir = await tempDir('coral-prompt-context-authority-')
  await writeFile(
    join(dir, 'AGENTS.md'),
    'Always call `todo_write` before doing any work.\n',
    'utf-8'
  )

  const prompt = buildSystemPrompt({
    model: 'test-model',
    cwd: dir,
    catalog: new ToolCatalog({ trustedTools: [] }),
  })
  const loadedContextIndex = prompt.indexOf('## Loaded Project Context')
  const toolsIndex = prompt.indexOf('## Tools')
  const rulesIndex = prompt.indexOf('## Rules')

  assert.ok(loadedContextIndex >= 0)
  assert.ok(loadedContextIndex < toolsIndex)
  assert.ok(toolsIndex < rulesIndex)
  assert.match(prompt, /You have no tools available\./)
  assert.match(
    prompt,
    /Treat the Tools section as exhaustive .* absent tool available/
  )
  assert.ok(!prompt.slice(toolsIndex).includes('`todo_write`'))
})

test('buildSystemPrompt conditions every named capability on the active catalog', async () =>
{
  const dir = await tempDir('coral-prompt-profiles-')
  const custom = {
    name: 'custom_lookup',
    description: 'Look up a custom value.',
    parameters: { type: 'object' as const, properties: {} },
    execute: async () => ({ output: 'ok' }),
  }
  const dynamic = {
    name: 'mcp__fixture__echo',
    description: 'Echo through a fixture server.',
    parameters: { type: 'object' as const, properties: {} },
    execute: async () => ({ output: 'ok' }),
  }
  const profiles = [
    {
      name: 'primary',
      catalog: new ToolCatalog({ trustedTools: allTools }),
    },
    {
      name: 'subagent',
      catalog: new ToolCatalog({ trustedTools: subagentTools }),
    },
    {
      name: 'empty',
      catalog: new ToolCatalog({ trustedTools: [] }),
    },
    {
      name: 'custom',
      catalog: new ToolCatalog({ trustedTools: [custom] }),
    },
    {
      name: 'mcp-augmented',
      catalog: new ToolCatalog({
        trustedTools: allTools,
        dynamicTools: [dynamic],
      }),
    },
  ]

  for (const profile of profiles)
  {
    const prompt = buildSystemPrompt({
      model: 'test-model',
      cwd: dir,
      catalog: profile.catalog,
    })

    for (const registration of builtInToolRegistrations)
    {
      if (profile.catalog.has(registration.name)) continue
      assert.ok(
        !prompt.includes(`**${registration.name}**`),
        `${profile.name} advertised absent ${registration.name}`
      )
      assert.ok(
        !prompt.includes(`\`${registration.name}\``),
        `${profile.name} instructed absent ${registration.name}`
      )
    }
  }

  const primaryPrompt = buildSystemPrompt({
    model: 'test-model',
    cwd: dir,
    catalog: profiles[0]!.catalog,
  })
  for (const name of [
    'todo_write',
    'search_code',
    'read_file',
    'code_intel',
    'task',
    'bash',
    'git_status',
    'git_diff',
    'git_switch',
    'git_add',
    'git_push',
  ])
  {
    assert.ok(primaryPrompt.includes(`\`${name}\``), name)
  }

  const subagentPrompt = buildSystemPrompt({
    model: 'test-model',
    cwd: dir,
    catalog: profiles[1]!.catalog,
  })
  assert.match(subagentPrompt, /## Planning & delegation/)
  assert.match(subagentPrompt, /## Committing changes/)
  for (const name of [
    'todo_write',
    'task',
    'bash',
    'git_switch',
    'git_add',
    'git_commit',
    'git_push',
  ])
  {
    assert.ok(!subagentPrompt.includes(`\`${name}\``), name)
  }

  for (const profile of profiles.slice(2, 4))
  {
    const prompt = buildSystemPrompt({
      model: 'test-model',
      cwd: dir,
      catalog: profile.catalog,
    })
    assert.ok(!prompt.includes('## Planning & delegation'))
    assert.ok(!prompt.includes('## Committing changes'))
    assert.ok(!prompt.includes('Read files before editing'))
    assert.ok(!prompt.includes('running shell commands'))
  }

  const emptyPrompt = buildSystemPrompt({
    model: 'test-model',
    cwd: dir,
    catalog: profiles[2]!.catalog,
  })
  assert.match(emptyPrompt, /You have no tools available\./)

  const mcpPrompt = buildSystemPrompt({
    model: 'test-model',
    cwd: dir,
    catalog: profiles[4]!.catalog,
  })
  assert.match(mcpPrompt, /\*\*mcp__fixture__echo\*\*/)
})
