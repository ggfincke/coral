// tests/tui/vim.test.ts
// tests for the pure vi-modal prompt editing engine

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  applyVimInput,
  createVimEngine,
  vimView,
  type VimEngine,
  type VimView,
} from '../../src/tui/prompt/vim.js'

const MULTI = 'alpha beta\ngamma delta\nepsilon'

// drives a run of printable keystrokes through the engine
function press(engine: VimEngine, ...keys: string[]): VimView
{
  let view = vimView(engine)
  for (const ch of keys)
  {
    view = applyVimInput(engine, { input: ch })
  }
  return view
}

test('engine starts in NORMAL holding the given draft', () =>
{
  const engine = createVimEngine(MULTI)
  const view = vimView(engine)
  assert.equal(view.mode, 'normal')
  assert.equal(view.value, MULTI)
  assert.equal(view.cursorOffset, 0)
  assert.equal(view.statusHint, null)
  assert.equal(view.submitRequested, false)
})

test('insert-entry positions i/a/I/A', () =>
{
  const engine = createVimEngine(MULTI)
  const view = press(engine, 'i')
  assert.equal(view.mode, 'insert')
  assert.equal(view.cursorOffset, 0)

  const after = createVimEngine(MULTI)
  const afterView = press(after, 'l', 'a')
  assert.equal(afterView.mode, 'insert')
  assert.equal(afterView.cursorOffset, 2)

  const indented = createVimEngine('  deep')
  const indentView = press(indented, 'I')
  assert.equal(indentView.mode, 'insert')
  assert.equal(indentView.cursorOffset, 2)

  const tail = createVimEngine(MULTI)
  const tailView = press(tail, '$', 'A')
  assert.equal(tailView.mode, 'insert')
  assert.equal(tailView.cursorOffset, 10)
})

test('o opens a line below and O above, both entering INSERT', () =>
{
  const engine = createVimEngine('ab\ncd')
  const below = press(engine, 'o')
  assert.equal(below.value, 'ab\n\ncd')
  assert.equal(below.cursorOffset, 3)
  assert.equal(below.mode, 'insert')
  const done = press(engine, 'x')
  const exited = applyVimInput(engine, { escape: true })
  assert.equal(done.value, 'ab\nx\ncd')
  assert.equal(exited.value, 'ab\nx\ncd')

  const other = createVimEngine('ab\ncd')
  press(other, 'j')
  const above = press(other, 'O')
  assert.equal(above.value, 'ab\n\ncd')
  assert.equal(above.cursorOffset, 3)
  press(other, 'y')
  assert.equal(vimView(other).value, 'ab\ny\ncd')
})

test('INSERT typing, return, backspace, and delete edit the draft', () =>
{
  const engine = createVimEngine('hi')
  press(engine, 'i', 'h', 'e', 'y')
  assert.equal(vimView(engine).value, 'heyhi')
  applyVimInput(engine, { return: true })
  assert.equal(vimView(engine).value, 'hey\nhi')
  assert.equal(vimView(engine).cursorOffset, 4)
  applyVimInput(engine, { backspace: true })
  assert.equal(vimView(engine).value, 'heyhi')
  applyVimInput(engine, { delete: true })
  assert.equal(vimView(engine).value, 'heyi')
  assert.equal(vimView(engine).cursorOffset, 3)
})

test('esc leaves INSERT moving back one, clamped to the line start', () =>
{
  const engine = createVimEngine(MULTI)
  press(engine, '$', 'a', '!')
  const exited = applyVimInput(engine, { escape: true })
  assert.equal(exited.mode, 'normal')
  assert.equal(exited.value, 'alpha beta!\ngamma delta\nepsilon')
  assert.equal(exited.cursorOffset, 10)

  const empty = createVimEngine('ab\n\ncd')
  press(empty, 'j', 'i')
  const stayed = applyVimInput(empty, { escape: true })
  assert.equal(stayed.cursorOffset, 3)

  const pending = createVimEngine(MULTI)
  const armed = press(pending, 'd')
  assert.equal(armed.statusHint, 'd')
  const cleared = applyVimInput(pending, { escape: true })
  assert.equal(cleared.statusHint, null)
  assert.equal(cleared.value, MULTI)
  const moved = press(pending, 'l')
  assert.equal(moved.cursorOffset, 1)
})

test('h/l stay clamped inside their own line', () =>
{
  const engine = createVimEngine(MULTI)
  assert.equal(press(engine, 'h').cursorOffset, 0)
  assert.equal(press(engine, 'l').cursorOffset, 1)
  press(engine, 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l')
  assert.equal(vimView(engine).cursorOffset, 9)
  press(engine, 'G', '$')
  assert.equal(vimView(engine).cursorOffset, 29)
  assert.equal(press(engine, 'l').cursorOffset, 29)
  assert.equal(press(engine, 'h').cursorOffset, 28)
})

test('j/k move by lines keeping the column clamped', () =>
{
  const engine = createVimEngine(MULTI)
  assert.equal(press(engine, 'j').cursorOffset, 11)
  assert.equal(press(engine, 'j').cursorOffset, 23)
  assert.equal(press(engine, 'j').cursorOffset, 23)
  assert.equal(press(engine, 'k').cursorOffset, 11)
  assert.equal(press(engine, 'k').cursorOffset, 0)
  assert.equal(press(engine, 'k').cursorOffset, 0)

  press(engine, 'j')
  press(engine, 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l')
  assert.equal(vimView(engine).cursorOffset, 20)
  assert.equal(press(engine, 'k').cursorOffset, 9)
  assert.equal(press(engine, 'j').cursorOffset, 20)
})

test('0 ^ $ jump within the line', () =>
{
  const engine = createVimEngine('  indented\ntwo')
  assert.equal(press(engine, '$').cursorOffset, 9)
  assert.equal(press(engine, '0').cursorOffset, 0)
  assert.equal(press(engine, '^').cursorOffset, 2)
  assert.equal(press(engine, 'j', '$').cursorOffset, 13)
})

test('w/b/e walk words, skipping separators and punctuation', () =>
{
  const engine = createVimEngine('alpha beta\ngamma')
  assert.equal(press(engine, 'w').cursorOffset, 6)
  assert.equal(press(engine, 'w').cursorOffset, 11)
  assert.equal(press(engine, 'w').cursorOffset, 15)

  const back = createVimEngine('alpha beta\ngamma')
  press(back, 'G')
  assert.equal(press(back, 'b').cursorOffset, 6)

  const ends = createVimEngine('alpha beta\ngamma')
  assert.equal(press(ends, 'e').cursorOffset, 4)
  assert.equal(press(ends, 'e').cursorOffset, 9)
  assert.equal(press(ends, 'e').cursorOffset, 15)

  const punct = createVimEngine('ab.c d')
  assert.equal(press(punct, 'w').cursorOffset, 3)
  assert.equal(press(punct, 'b').cursorOffset, 0)
  const punctEnd = createVimEngine('ab.c d')
  assert.equal(press(punctEnd, 'e').cursorOffset, 1)
})

test('gg lands on the first line and G on the last, keeping the column', () =>
{
  const engine = createVimEngine(MULTI)
  assert.equal(press(engine, 'G').cursorOffset, 23)
  assert.equal(press(engine, 'g', 'g').cursorOffset, 0)

  const far = createVimEngine(MULTI)
  press(far, 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l')
  assert.equal(vimView(far).cursorOffset, 8)
  assert.equal(press(far, 'G').cursorOffset, 29)
  assert.equal(press(far, 'g', 'g').cursorOffset, 6)
})

test('dw deletes through word start into the register and stays NORMAL', () =>
{
  const engine = createVimEngine(MULTI)
  const view = press(engine, 'd', 'w')
  assert.equal(view.value, 'beta\ngamma delta\nepsilon')
  assert.equal(vimView(engine).mode, 'normal')
  assert.equal(vimView(engine).cursorOffset, 0)
  // register is internal; observe it via a following paste
  press(engine, 'P')
  assert.equal(vimView(engine).value, 'alpha beta\ngamma delta\nepsilon')

  const plain = createVimEngine('one two three')
  const plainView = press(plain, 'd', 'w')
  assert.equal(plainView.value, 'two three')
  press(plain, 'P')
  assert.equal(vimView(plain).value, 'one two three')

  const lastWord = createVimEngine('ab cd')
  press(lastWord, 'l', 'l', 'l')
  const cut = press(lastWord, 'd', 'w')
  assert.equal(cut.value, 'ab ')
  press(lastWord, '$', 'P')
  assert.equal(vimView(lastWord).value, 'abcd ')
})

test('dd removes the whole line and p round-trips it', () =>
{
  const engine = createVimEngine(MULTI)
  press(engine, 'j')
  const cut = press(engine, 'd', 'd')
  assert.equal(cut.value, 'alpha beta\nepsilon')
  assert.equal(cut.statusHint, null)
  assert.equal(cut.cursorOffset, 11)
  press(engine, 'k')
  const restored = press(engine, 'p')
  assert.equal(restored.value, MULTI)
  assert.equal(restored.cursorOffset, 11)
})

test('cc clears the line body and enters INSERT', () =>
{
  const engine = createVimEngine('aa\nbb\ncd')
  press(engine, 'j')
  const changed = press(engine, 'c', 'c')
  assert.equal(changed.value, 'aa\n\ncd')
  assert.equal(changed.mode, 'insert')
  assert.equal(changed.cursorOffset, 3)
  press(engine, 'z')
  const exited = applyVimInput(engine, { escape: true })
  assert.equal(exited.value, 'aa\nz\ncd')
  assert.equal(exited.mode, 'normal')
})

test('cw changes the word and hands off to INSERT', () =>
{
  const engine = createVimEngine('foo bar baz')
  const changed = press(engine, 'c', 'w')
  assert.equal(changed.value, 'bar baz')
  assert.equal(changed.mode, 'insert')
  assert.equal(changed.cursorOffset, 0)
  press(engine, 'q', 'u', 'x')
  const exited = applyVimInput(engine, { escape: true })
  assert.equal(exited.value, 'quxbar baz')
  assert.equal(exited.mode, 'normal')
  assert.equal(exited.cursorOffset, 2)
})

test('x deletes the character under the cursor', () =>
{
  const engine = createVimEngine('abc')
  const cut = press(engine, 'l', 'x')
  assert.equal(cut.value, 'ac')
  assert.equal(cut.cursorOffset, 1)
  press(engine, '$', 'x', 'x')
  assert.equal(vimView(engine).value, '')
})

test('p/P paste charwise and yy+p duplicate lines', () =>
{
  const engine = createVimEngine('hello')
  const yanked = press(engine, 'y', 'l')
  assert.equal(yanked.value, 'hello')
  assert.equal(yanked.mode, 'normal')
  const pasted = press(engine, 'p')
  assert.equal(pasted.value, 'hhello')
  assert.equal(pasted.cursorOffset, 1)

  const before = createVimEngine('ello')
  press(before, 'y', 'l')
  const prepended = press(before, 'P')
  assert.equal(prepended.value, 'eello')
  assert.equal(prepended.cursorOffset, 0)

  const lines = createVimEngine(MULTI)
  press(lines, 'y', 'y')
  assert.equal(vimView(lines).value, MULTI)
  const doubled = press(lines, 'p')
  assert.equal(doubled.value, `alpha beta\n${MULTI}`)
  assert.equal(doubled.cursorOffset, 11)
})

test('daw removes the word plus one adjacent space', () =>
{
  const engine = createVimEngine('foo bar baz')
  const cut = press(engine, 'd', 'a', 'w')
  assert.equal(cut.value, 'bar baz')
  assert.equal(cut.mode, 'normal')
  assert.equal(cut.cursorOffset, 0)
  press(engine, 'P')
  assert.equal(vimView(engine).value, 'foo bar baz')

  const trailing = createVimEngine('x foo')
  press(trailing, 'l', 'l')
  const leftCut = press(trailing, 'd', 'a', 'w')
  assert.equal(leftCut.value, 'x')
  press(trailing, 'P')
  assert.equal(vimView(trailing).value, ' foox')
})

test('ci" changes the quoted span; an unenclosed object fails cleanly', () =>
{
  const engine = createVimEngine('say "hi there" now')
  press(engine, 'l', 'l', 'l', 'l', 'l', 'l')
  const changed = press(engine, 'c', 'i', '"')
  assert.equal(changed.value, 'say "" now')
  assert.equal(changed.mode, 'insert')
  assert.equal(changed.cursorOffset, 5)
  press(engine, 'y', 'o')
  const exited = applyVimInput(engine, { escape: true })
  assert.equal(exited.value, 'say "yo" now')
  assert.equal(exited.cursorOffset, 6)

  const missing = createVimEngine('no quotes here')
  const failed = press(missing, 'c', 'i', "'")
  assert.equal(failed.value, 'no quotes here')
  assert.equal(failed.mode, 'normal')
  assert.equal(failed.statusHint, null)
})

test('dot repeats the last completed change at the current position', () =>
{
  const engine = createVimEngine('one two three four')
  assert.equal(press(engine, 'd', 'w').value, 'two three four')
  assert.equal(press(engine, '.').value, 'three four')
  assert.equal(press(engine, '.').value, 'four')
  // repeating dw on the final word empties the buffer; further dots fail cleanly
  assert.equal(press(engine, '.').value, '')
  assert.equal(press(engine, '.').value, '')
})

test('ex commands: :wq submits, unknown hints until the next keypress', () =>
{
  const engine = createVimEngine('draft')
  const opened = press(engine, ':')
  assert.equal(opened.statusHint, ':')
  const typed = press(engine, 'w', 'q')
  assert.equal(typed.statusHint, ':wq')
  const submitted = applyVimInput(engine, { return: true })
  assert.equal(submitted.submitRequested, true)
  assert.equal(submitted.statusHint, null)
  assert.equal(submitted.mode, 'normal')
  assert.equal(press(engine, 'l').cursorOffset, 1)

  const bad = createVimEngine('x')
  press(bad, ':', 'z', 'z')
  const rejected = applyVimInput(bad, { return: true })
  assert.equal(rejected.submitRequested, false)
  assert.equal(rejected.statusHint, 'not an editor command: zz')
  const cleared = press(bad, 'h')
  assert.equal(cleared.statusHint, null)

  const quiet = createVimEngine('x')
  press(quiet, ':', 'q')
  const closed = applyVimInput(quiet, { return: true })
  assert.equal(closed.submitRequested, false)
  assert.equal(closed.statusHint, null)

  const cancelled = createVimEngine('x')
  press(cancelled, ':', 'w')
  const aborted = applyVimInput(cancelled, { escape: true })
  assert.equal(aborted.submitRequested, false)
  assert.equal(aborted.statusHint, null)
})
