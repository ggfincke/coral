// tests/tui/editor-handoff.test.ts
// tests for external-editor command resolution & apply rules

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildEditorArgs,
  resolveEditorCommand,
  shouldApplyEdit,
  splitEditorCommand,
} from '../../src/tui/prompt/editor-handoff.js'

test('VISUAL beats EDITOR beats the platform default', () =>
{
  assert.equal(resolveEditorCommand({ VISUAL: 'nvim', EDITOR: 'vim' }), 'nvim')
  assert.equal(resolveEditorCommand({ EDITOR: 'vim' }), 'vim')
  assert.equal(
    resolveEditorCommand({}),
    process.platform === 'win32' ? null : 'vi'
  )
  // whitespace-only VISUAL is ignored, falling through like an unset value
  const fallback = resolveEditorCommand({ VISUAL: '   ' })
  assert.equal(fallback, process.platform === 'win32' ? null : 'vi')
})

test('splitEditorCommand handles flag-carrying values', () =>
{
  assert.deepEqual(splitEditorCommand('code -w'), ['code', '-w'])
  assert.deepEqual(splitEditorCommand('vim'), ['vim'])
})

test('buildEditorArgs appends a wait flag for vscode & the file last', () =>
{
  // the binary itself is spawned separately; args carry flags + target only
  assert.deepEqual(buildEditorArgs('vim', '/tmp/d.md'), ['/tmp/d.md'])
  assert.deepEqual(buildEditorArgs('code -w', '/tmp/d.md'), ['-w', '/tmp/d.md'])
})

test('empty or identical results cancel; real edits apply', () =>
{
  const original = 'draft text'

  assert.equal(shouldApplyEdit(original, null), false)
  assert.equal(shouldApplyEdit(original, '   \n'), false)
  assert.equal(shouldApplyEdit(original, original), false)
  assert.equal(shouldApplyEdit(original, 'edited\n'), true)
})
