// tests/tui/editor-handoff.test.ts
// tests for external-editor command resolution & apply rules

import { strict as assert } from 'node:assert'
import {
  expandPastePlaceholders,
  buildPastePlaceholder,
} from '../../src/tui/prompt/paste.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildEditorArgs,
  runInExternalEditor,
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

test('external editing receives expanded pasted text and preserves the original on cancellation or failure', async () =>
{
  const dir = mkdtempSync(join(tmpdir(), 'coral-editor-test-'))
  const script = join(dir, 'edit.cjs')
  const pasted = 'multiline\n' + 'x'.repeat(1100)
  const draft = expandPastePlaceholders(
    `inspect ${buildPastePlaceholder(1, pasted)}`,
    () => pasted
  )
  try
  {
    writeFileSync(
      script,
      `const fs = require('node:fs'); const file = process.argv[2]; const text = fs.readFileSync(file, 'utf8'); if (!text.includes('multiline\\n') || text.includes('[Pasted text')) process.exit(3); fs.writeFileSync(file, text + '\\nedited');`
    )
    assert.equal(
      (
        await runInExternalEditor(draft, {
          VISUAL: `${process.execPath} ${script}`,
        })
      ).text,
      draft + '\nedited'
    )
    writeFileSync(script, '')
    assert.equal(
      (
        await runInExternalEditor(draft, {
          VISUAL: `${process.execPath} ${script}`,
        })
      ).text,
      null
    )
    writeFileSync(script, 'process.exit(7)')
    await assert.rejects(
      runInExternalEditor(draft, { VISUAL: `${process.execPath} ${script}` }),
      /Editor exited 7/
    )
    assert.ok(draft.endsWith(pasted))
  }
  finally
  {
    rmSync(dir, { recursive: true, force: true })
  }
})
