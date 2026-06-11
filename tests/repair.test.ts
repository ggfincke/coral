// tests/repair.test.ts
// unit tests for text -> tool-call recovery parsing

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseToolCallsFromContent } from '../src/agent/repair.js'

const TOOLS = ['read_file', 'grep', 'list_files', 'git_status']

test('recovers tool calls from the common text shapes', () =>
{
  // bare JSON as the whole message
  const bare = parseToolCallsFromContent(
    '{"name": "read_file", "arguments": {"path": "src/main.ts"}}',
    TOOLS
  )
  assert.equal(bare?.[0]?.function.name, 'read_file')
  assert.deepEqual(bare?.[0]?.function.arguments, { path: 'src/main.ts' })

  // narration followed by trailing JSON
  const trailing = parseToolCallsFromContent(
    'Let me check the repo status now: {"name": "git_status", "arguments": {}}',
    TOOLS
  )
  assert.equal(trailing?.[0]?.function.name, 'git_status')

  // fenced code block
  const fenced = parseToolCallsFromContent(
    'I will inspect the file.\n```json\n{"name": "read_file", "arguments": {"path": "package.json"}}\n```',
    TOOLS
  )
  assert.equal(fenced?.[0]?.function.name, 'read_file')

  // leaked template wrapper tokens
  const wrapped = parseToolCallsFromContent(
    '<|tool_call|>{"name": "list_files", "arguments": {"path": "."}}<|/tool_call|>',
    TOOLS
  )
  assert.equal(wrapped?.[0]?.function.name, 'list_files')
})

test('rejects JSON that is not a tool call', () =>
{
  // unknown tool name
  assert.equal(
    parseToolCallsFromContent(
      '{"name": "fixture", "arguments": {"path": "x"}}',
      TOOLS
    ),
    null
  )

  // known name but no arguments key — ordinary JSON mentioning a tool
  assert.equal(parseToolCallsFromContent('{"name": "read_file"}', TOOLS), null)

  // package.json-like content w/ a name field
  assert.equal(
    parseToolCallsFromContent(
      '{"name": "coral", "version": "0.10.0", "arguments": {}}',
      TOOLS
    ),
    null
  )

  // plain prose
  assert.equal(parseToolCallsFromContent('I will read the file.', TOOLS), null)
})
