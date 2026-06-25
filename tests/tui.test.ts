// tests/tui.test.ts
// tests for major TUI transcript behavior

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import stripAnsi from 'strip-ansi'
import {
  buildTranscriptLines,
  maxScrollOffset,
  sliceViewport,
  type OutputBlock,
} from '../src/tui/transcript.js'
import { buildApprovalBox, buildConfirmBox } from '../src/tui/approval-box.js'
import {
  formatAutoCompactionResult,
  formatCliSessionList,
  formatManualCompactionResult,
  formatPermissionModeChange,
  formatPermissionsHelp,
  formatTuiResumeResolution,
  formatTuiSessionList,
} from '../src/tui/command-output.js'
import type { CompactionResult } from '../src/agent/agent.js'
import type { ResumeSessionResolution } from '../src/session/resume.js'
import type { SessionMeta } from '../src/session/store.js'
import { makeSessionMeta } from './helpers/session.js'

function plain(lines: string | string[]): string
{
  return stripAnsi(Array.isArray(lines) ? lines.join('\n') : lines)
}

const makeSession = (id: string, title?: string): SessionMeta =>
  makeSessionMeta(title === undefined ? { id } : { id, title })

test('buildTranscriptLines renders conversation and tool results in scrollable order', () =>
{
  const blocks: OutputBlock[] = [
    { type: 'user', content: 'inspect src/agent/agent.ts' },
    { type: 'thinking', content: 'Inspect the prompt and tool flow first.' },
    { type: 'assistant', content: '## Findings\n\n- approval flow exists' },
    {
      type: 'tool_call',
      toolName: 'read_file',
      args: { path: 'src/agent/agent.ts' },
      status: 'success',
      duration: 200,
    },
    {
      type: 'tool_result',
      toolName: 'read_file',
      content: 'file contents here',
    },
  ]

  const lines = buildTranscriptLines({ blocks, streaming: '', width: 60 }).map(
    (line) => stripAnsi(line)
  )
  const viewportHeight = 5
  const liveViewport = sliceViewport(lines, viewportHeight, 0)
  const topViewport = sliceViewport(
    lines,
    viewportHeight,
    maxScrollOffset(lines.length, viewportHeight)
  )

  assert.ok(lines.some((line) => line.includes('inspect src/agent/agent.ts')))
  assert.ok(lines.some((line) => line.includes('approval flow exists')))
  assert.ok(lines.some((line) => line.includes('file contents here')))
  assert.equal(topViewport[0], lines[0])
  assert.equal(liveViewport.at(-1), lines.at(-1))
})

test('buildTranscriptLines hides saved reasoning while preserving a live hint', () =>
{
  const blocks: OutputBlock[] = [
    { type: 'thinking', content: 'Read the repo before answering.' },
    { type: 'assistant', content: 'Ready.' },
  ]

  const hiddenLines = buildTranscriptLines({
    blocks,
    streaming: '',
    width: 60,
    showThinking: false,
  }).map((line) => stripAnsi(line))
  const liveHiddenLines = buildTranscriptLines({
    blocks: [],
    streaming: '',
    width: 60,
    streamingThinking: 'Inspecting files',
    showThinking: false,
  }).map((line) => stripAnsi(line))

  assert.ok(
    !hiddenLines.some((line) =>
      line.includes('Read the repo before answering.')
    )
  )
  assert.ok(hiddenLines.some((line) => line.includes('Ready.')))
  assert.ok(liveHiddenLines.some((line) => line.includes('Thinking')))
  assert.ok(liveHiddenLines.some((line) => line.includes('ctrl+t to show')))
})

test('session list formatters share rows across CLI and TUI surfaces', () =>
{
  const sessions = [makeSession('abcd1234', 'Inspect files')]
  const cli = plain(formatCliSessionList(sessions))
  const tui = plain(formatTuiSessionList(sessions, 'abcd1234'))

  assert.ok(cli.includes('1 saved session(s):'))
  assert.ok(cli.includes('abcd1234  test-model'))
  assert.ok(cli.includes('Inspect files'))
  assert.ok(cli.includes('Resume with: coral --session <id>'))

  assert.ok(tui.includes('Coral — saved sessions'))
  assert.ok(tui.includes('● abcd1234  test-model'))
  assert.ok(tui.includes('Inspect files'))
  assert.ok(tui.includes('Resume with /resume <id>'))
})

test('resume resolution formatter covers current, missing, and ambiguous states', () =>
{
  const sessions = [makeSession('abcd1234'), makeSession('abce5678')]
  const current = plain(
    formatTuiResumeResolution({ type: 'current', session: sessions[0]! })
  )
  const missing = plain(
    formatTuiResumeResolution({ type: 'not_found', requestedId: 'missing' })
  )
  const ambiguous: ResumeSessionResolution = {
    type: 'ambiguous',
    requestedId: 'abc',
    matches: sessions,
  }

  assert.equal(current, 'Already in this session.')
  assert.ok(missing.includes('Session not found: missing'))
  assert.ok(missing.includes('/sessions'))
  assert.ok(plain(formatTuiResumeResolution(ambiguous)).includes('abcd1234'))
})

test('permission and compaction formatters preserve command copy', () =>
{
  const compacted: CompactionResult = {
    type: 'summarized',
    beforeMessages: 8,
    afterMessages: 4,
    beforeTokens: 900,
    afterTokens: 300,
  }
  const pruned: CompactionResult = {
    type: 'pruned',
    beforeMessages: 8,
    afterMessages: 8,
    beforeTokens: 1200,
    afterTokens: 800,
    prunedResults: 2,
  }

  assert.ok(
    plain(formatPermissionsHelp(false)).includes('Permission mode: ask')
  )
  assert.ok(
    plain(formatPermissionModeChange(true)).includes(
      'Permission mode → yolo (all tool calls auto-approved)'
    )
  )
  assert.ok(
    plain(formatManualCompactionResult(compacted)).includes(
      '8 messages -> 4 messages (4 summarized)'
    )
  )
  assert.ok(
    plain(formatAutoCompactionResult(pruned)).includes(
      'Auto-pruned 2 old tool results'
    )
  )
})

test('approval and confirm boxes share framed prompt rendering', () =>
{
  const approval = plain(buildApprovalBox('bash', { command: 'npm test' }, 50))
  const confirm = plain(buildConfirmBox('Continue anyway?', 50, 'confirm'))

  assert.ok(approval.includes('tool approval'))
  assert.ok(approval.includes('Allow bash?'))
  assert.ok(approval.includes('$ npm test'))
  assert.ok(approval.includes('(y) approve  (n) reject  (esc) cancel'))

  assert.ok(confirm.includes('confirm'))
  assert.ok(confirm.includes('Continue anyway?'))
  assert.ok(confirm.includes('(y) continue  (n) stop'))
})
