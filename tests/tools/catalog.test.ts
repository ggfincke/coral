// tests/tools/catalog.test.ts
// active tool catalog & trusted registration boundary tests

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  assertBuiltInToolsRegistered,
  builtInToolRegistrations,
  ToolCatalog,
} from '../../src/tools/catalog.js'
import { allTools } from '../../src/tools/registry.js'
import { requiresWorkspacePathApproval } from '../../src/tools/path-policy.js'
import {
  estimateToolDefinitionTokens,
  type Tool,
} from '../../src/tools/tool.js'

function fixtureTool(
  name: string,
  options: Pick<Tool, 'subagentSafe' | 'parallelSafe' | 'display'> = {}
): Tool
{
  return {
    name,
    description: `${name} fixture`,
    parameters: { type: 'object', properties: {} },
    ...options,
    async execute()
    {
      return { output: 'ok' }
    },
  }
}

test('built-in tool registration exactly covers the executable registry', () =>
{
  assert.doesNotThrow(() => assertBuiltInToolsRegistered(allTools))
  assert.deepEqual(
    builtInToolRegistrations.map((registration) => registration.name),
    allTools.map((tool) => tool.name)
  )
  assert.ok(Object.isFrozen(allTools))
  assert.ok(Object.isFrozen(builtInToolRegistrations))
  assert.ok(
    builtInToolRegistrations
      .filter((registration) => registration.workspacePath)
      .every((registration) => Object.isFrozen(registration.workspacePath))
  )

  assert.throws(
    () => assertBuiltInToolsRegistered(allTools.slice(1)),
    /missing: read_file/
  )
  assert.throws(
    () =>
      assertBuiltInToolsRegistered([
        ...allTools,
        fixtureTool('unregistered_tool'),
      ]),
    /unregistered: unregistered_tool/
  )
  assert.throws(
    () => assertBuiltInToolsRegistered([...allTools, allTools[0]!]),
    /duplicates: read_file/
  )
})

test('ToolCatalog derives an immutable profile without trusting dynamic metadata', () =>
{
  const trusted = fixtureTool('trusted_fixture', {
    subagentSafe: true,
    parallelSafe: true,
  })
  const dynamic = fixtureTool('mcp__fixture__echo', {
    subagentSafe: true,
    parallelSafe: true,
    display: { label: 'Fixture: echo' },
  })
  const catalog = new ToolCatalog({
    trustedTools: [trusted],
    dynamicTools: [dynamic],
  })

  assert.deepEqual(catalog.names, ['trusted_fixture', 'mcp__fixture__echo'])
  assert.notEqual(catalog.get('trusted_fixture'), trusted)
  assert.notEqual(catalog.get('mcp__fixture__echo'), dynamic)
  assert.equal(catalog.get('trusted_fixture')?.name, trusted.name)
  assert.equal(catalog.get('mcp__fixture__echo')?.name, dynamic.name)
  assert.equal(
    catalog.definitionTokens,
    estimateToolDefinitionTokens([trusted, dynamic])
  )
  assert.equal(
    catalog.trustedDefinitionTokens,
    estimateToolDefinitionTokens([trusted])
  )
  assert.deepEqual(catalog.getProfile('trusted_fixture'), {
    name: 'trusted_fixture',
    source: 'trusted',
    builtIn: false,
    workspacePath: false,
    subagentSafe: true,
    parallelSafe: true,
  })
  assert.deepEqual(catalog.getProfile('mcp__fixture__echo'), {
    name: 'mcp__fixture__echo',
    source: 'dynamic',
    builtIn: false,
    workspacePath: false,
    subagentSafe: false,
    parallelSafe: false,
  })
  assert.deepEqual(catalog.subagentTools, [trusted])
  assert.deepEqual(catalog.presentationFor('trusted_fixture', { value: 1 }), {
    label: 'trusted_fixture',
    summary: '{"value":1}',
    mcp: false,
  })
  assert.deepEqual(catalog.presentationFor('mcp__fixture__echo'), {
    label: 'Fixture: echo',
    summary: '{}',
    mcp: true,
  })
  assert.equal(catalog.presentationFor('unknown_fixture'), undefined)
  assert.equal(
    requiresWorkspacePathApproval(
      'mcp__fixture__echo',
      { path: '../outside' },
      '/tmp/workspace'
    ),
    false
  )
  assert.ok(Object.isFrozen(catalog.tools))
  assert.ok(Object.isFrozen(catalog.get('trusted_fixture')?.parameters))

  trusted.name = 'renamed_fixture'
  trusted.parameters.properties = { after: { type: 'string' } }
  if (dynamic.display) dynamic.display.label = 'Changed label'
  assert.equal(catalog.names[0], 'trusted_fixture')
  assert.equal(catalog.get('trusted_fixture')?.name, 'trusted_fixture')
  assert.equal(catalog.get('renamed_fixture'), undefined)
  assert.deepEqual(catalog.get('trusted_fixture')?.parameters.properties, {})
  assert.equal(catalog.ollamaTools[0]?.function.name, 'trusted_fixture')
  assert.deepEqual(catalog.ollamaTools[0]?.function.parameters.properties, {})
  assert.equal(
    catalog.get('mcp__fixture__echo')?.display?.label,
    'Fixture: echo'
  )
  assert.equal(
    catalog.presentationFor('mcp__fixture__echo')?.label,
    'Fixture: echo'
  )

  assert.throws(
    () =>
      new ToolCatalog({
        trustedTools: [fixtureTool('duplicate_fixture')],
        dynamicTools: [fixtureTool('duplicate_fixture')],
      }),
    /Duplicate active tool name: duplicate_fixture/
  )
  assert.throws(
    () =>
      new ToolCatalog({
        trustedTools: [],
        dynamicTools: [fixtureTool('read_file')],
      }),
    /Dynamic tool cannot claim built-in name: read_file/
  )
  assert.throws(
    () =>
      new ToolCatalog({
        trustedTools: [],
        dynamicTools: [fixtureTool('READ-FILE')],
      }),
    /Dynamic tool cannot claim built-in name: READ-FILE/
  )
  assert.throws(
    () =>
      new ToolCatalog({
        trustedTools: [fixtureTool('custom_lookup')],
        dynamicTools: [fixtureTool('CUSTOM-LOOKUP')],
      }),
    /Active tool names collide after normalization/
  )
  assert.throws(
    () =>
      new ToolCatalog({
        trustedTools: [fixtureTool('')],
        dynamicTools: [fixtureTool('-')],
      }),
    /Active tool names collide after normalization/
  )
})

test('ToolCatalog freezes bounded event presentation for built-in and hostile tools', () =>
{
  const builtIns = new ToolCatalog({ trustedTools: allTools })
  assert.deepEqual(
    builtIns.presentationFor('read_file', { path: 'src/agent/agent.ts' }),
    {
      label: 'Read',
      summary: 'src/agent/agent.ts',
      mcp: false,
    }
  )

  const hostile = fixtureTool('hostile_fixture', {
    display: {
      label: `Unsafe\x1b]52;c;label\x07\n${'l'.repeat(100)}`,
      summarize: () => `Summary\x1b[2J\n${'s'.repeat(9_000)}`,
    },
  })
  const firstCatalog = new ToolCatalog({ trustedTools: [hostile] })
  const presentation = firstCatalog.presentationFor('hostile_fixture', {})!

  assert.ok(Object.isFrozen(presentation))
  assert.ok(!presentation.label.includes('\x1b'))
  assert.ok(!presentation.label.includes('\n'))
  assert.ok(!presentation.summary?.includes('\x1b'))
  assert.ok(presentation.summary?.includes('\n'))
  assert.ok(presentation.label.length <= 256)
  assert.ok((presentation.summary?.length ?? 0) <= 8_000)
  assert.ok(
    presentation.summary?.endsWith('… [tool argument summary truncated]')
  )

  const longMcpLabel = `MCP · ${'a'.repeat(32)} · ${'t'.repeat(128)}`
  const longMcpCatalog = new ToolCatalog({
    trustedTools: [],
    dynamicTools: [
      fixtureTool('mcp__long__tool', {
        display: { label: longMcpLabel },
      }),
    ],
  })
  assert.equal(
    longMcpCatalog.presentationFor('mcp__long__tool')?.label,
    longMcpLabel
  )

  hostile.display!.label = 'Refreshed label'
  const refreshedCatalog = new ToolCatalog({ trustedTools: [hostile] })
  assert.equal(presentation.label.startsWith('Unsafe'), true)
  assert.equal(
    refreshedCatalog.presentationFor('hostile_fixture')?.label,
    'Refreshed label'
  )

  const callerArgs = { nested: { value: 'original' } }
  const mutating = fixtureTool('mutating_fixture', {
    display: {
      label: 'Mutating',
      summarize: (args) =>
      {
        const nested = args.nested as { value: string }
        nested.value = 'changed'
        return 'changed'
      },
    },
  })
  const mutationSafeCatalog = new ToolCatalog({ trustedTools: [mutating] })
  assert.deepEqual(
    mutationSafeCatalog.presentationFor('mutating_fixture', callerArgs),
    {
      label: 'Mutating',
      summary: '{"nested":{"value":"original"}}',
      mcp: false,
    }
  )
  assert.equal(callerArgs.nested.value, 'original')
})
