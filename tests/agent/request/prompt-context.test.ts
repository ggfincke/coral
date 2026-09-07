// tests/agent/request/prompt-context.test.ts
// project context gather and system prompt assembly

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  captureProjectContext,
  gatherProjectContext,
  projectContextBudgetForWindow,
  renderProjectContext,
} from '../../../src/agent/request/project-context.js'
import { buildSystemPrompt } from '../../../src/agent/request/system-prompt.js'
import { RequestPlanner } from '../../../src/agent/loop/request-planner.js'
import {
  builtInToolRegistrations,
  ToolCatalog,
} from '../../../src/tools/catalog.js'
import { allTools, subagentTools } from '../../../src/tools/registry.js'
import type { Tool } from '../../../src/tools/tool.js'
import { makeTempDirPool } from '../../helpers/temp.js'

describe('project-context', () =>
{
  const { tempDir } = makeTempDirPool()

  const tempProject = () => tempDir('coral-ctx-')

  test('gatherProjectContext loads project instructions and key metadata', async () =>
  {
    const dir = await tempProject()
    await writeFile(
      join(dir, '.coral.md'),
      '# Project Instructions\nDo this.\n'
    )
    await writeFile(join(dir, 'README.md'), '# My App\n')
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'my-app' })
    )
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'index.ts'), '// entry\n')

    const ctx = gatherProjectContext(dir)

    assert.match(ctx, /Project Instructions/)
    assert.match(ctx, /Detected project type: Node\.js\/JavaScript/)
    assert.match(ctx, /package\.json/)
    assert.match(ctx, /my-app/)
    assert.match(ctx, /Directory structure/)
    assert.match(ctx, /src\//)
    assert.match(ctx, /index\.ts/)
  })

  test('gatherProjectContext truncates oversized context files', async () =>
  {
    const dir = await tempProject()
    const bigContent = 'x'.repeat(10_000)
    await writeFile(join(dir, 'README.md'), bigContent)

    const ctx = gatherProjectContext(dir)

    assert.match(ctx, /truncated/)
    assert.ok(ctx.length < bigContent.length)
  })

  test('projectContextBudgetForWindow scales and clamps the injected budget', () =>
  {
    assert.equal(projectContextBudgetForWindow(32_768), 16_384)
    assert.equal(projectContextBudgetForWindow(262_144), 32_768)
  })

  test('gatherProjectContext respects an explicit total budget', async () =>
  {
    const dir = await tempProject()
    await writeFile(join(dir, '.coral.md'), 'x'.repeat(600))

    const ctx = gatherProjectContext(dir, { maxTotalChars: 300 })

    assert.match(ctx, /truncated to fit budget/)
    assert.ok(ctx.length <= 300)
  })

  test('one bounded snapshot supports every fit budget without filesystem rereads', async (t) =>
  {
    const dir = await tempProject()
    await writeFile(
      join(dir, '.coral.md'),
      'i'.repeat(8_191) + '🙂'.repeat(8_000)
    )
    await writeFile(join(dir, 'AGENTS.md'), 'a'.repeat(20_000))
    await writeFile(join(dir, 'package.json'), '{"name":"fixture"}')
    await mkdir(join(dir, 'README.md'))
    await mkdir(join(dir, '.hidden'))
    const opens = t.mock.method(fs, 'openSync')
    const reads = t.mock.method(fs, 'readSync')
    const directories = t.mock.method(fs, 'readdirSync')
    syncBuiltinESMExports()
    t.after(() =>
    {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    })

    assert.equal(gatherProjectContext(dir, { maxTotalChars: 0 }), '')
    assert.equal(opens.mock.callCount(), 0)
    assert.equal(directories.mock.callCount(), 0)
    const snapshot = captureProjectContext(dir)
    assert.equal(opens.mock.callCount(), 17)
    assert.equal(
      directories.mock.calls.filter((call) => call.arguments[0] === dir).length,
      1
    )
    assert.deepEqual(
      snapshot.files.map((file) => file.name),
      ['.coral.md', 'AGENTS.md', 'package.json']
    )
    assert.equal(
      snapshot.files[0]!.content,
      'i'.repeat(8_191) + '\n… (truncated)'
    )
    assert.match(snapshot.rootSummary, /\.hidden\//)
    assert.ok(!snapshot.directoryTree.includes('.hidden'))
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.files))
    assert.ok(snapshot.files.every(Object.isFrozen))
    assert.equal(
      reads.mock.calls.reduce((total, call) => total + Number(call.result), 0),
      8_193 * 2 + Buffer.byteLength('{"name":"fixture"}')
    )
    for (const call of reads.mock.calls)
    {
      assert.ok(Number(call.arguments[3]) <= 8_193)
    }
    const counts = [
      opens.mock.callCount(),
      reads.mock.callCount(),
      directories.mock.callCount(),
    ]
    await writeFile(join(dir, '.coral.md'), 'new content after capture')
    let builds = 0
    const plan = new RequestPlanner().fitSystemPrompt({
      contextWindow: 4_096,
      activeContent: 'inspect this project',
      tools: [],
      desiredProjectContextBudget: 32_768,
      systemContentAt(projectContextBudget)
      {
        builds++
        const rendered = renderProjectContext(snapshot, {
          maxTotalChars: projectContextBudget,
        })
        assert.ok(rendered.length <= projectContextBudget)
        return buildSystemPrompt({
          model: 'test-model',
          cwd: dir,
          catalog: new ToolCatalog({ trustedTools: [] }),
          projectContextBudget,
          projectContextSnapshot: snapshot,
        })
      },
    })
    assert.ok(builds > 2)
    assert.equal(plan.budget.fits, true)
    assert.match(plan.content, /Detected project type: Node\.js\/JavaScript/)
    assert.ok(!plan.content.includes('new content after capture'))
    assert.deepEqual(
      [
        opens.mock.callCount(),
        reads.mock.callCount(),
        directories.mock.callCount(),
      ],
      counts
    )
    assert.match(gatherProjectContext(dir), /new content after capture/)
  })
})

describe('system-prompt', () =>
{
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
})
