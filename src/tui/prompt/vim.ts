// src/tui/prompt/vim.ts
// pure vi-modal editing engine for the prompt composer

import {
  buildLineStarts,
  lineSpanAt,
  rowSpan,
  type LineSpan,
} from './line-index.js'
import {
  clampGraphemeOffset,
  graphemeOffsets,
  nextGraphemeOffset,
  previousGraphemeOffset,
} from './grapheme.js'

export type VimMode = 'insert' | 'normal'

export interface VimKey
{
  input?: string
  escape?: boolean
  return?: boolean
  backspace?: boolean
  delete?: boolean
}

export interface VimView
{
  mode: VimMode
  value: string
  cursorOffset: number
  // '-- INSERT --', an operator-pending marker like 'd', ':cmdline text', or null
  statusHint: string | null
  // set once when a :wq or :x ex command evaluates; the consumer resets the engine
  submitRequested: boolean
  // set once by NORMAL `u`; the consumer owns the undo history
  undoRequested: boolean
}

export type VimEngine = {
  // opaque engine state; construct only via createVimEngine
  readonly state: unknown
}

type Operator = 'd' | 'c' | 'y'

// completed-change spec for dot repeat; target '' encodes the doubled linewise form
interface ChangeSpec
{
  operator: Operator
  target: string
  // text a `c` change typed before Esc, replayed with it
  text?: string
}

// a `c` change waiting for its INSERT session to end
interface PendingChangeInsert
{
  change: ChangeSpec
  before: string
  start: number
}

interface VimState
{
  mode: VimMode
  value: string
  cursor: number
  register: string
  registerLinewise: boolean
  pendingOperator: Operator | null
  pendingObject: 'i' | 'a' | null
  pendingG: boolean
  cmdlineActive: boolean
  cmdlineText: string
  stickyHint: string | null
  submitRequested: boolean
  undoRequested: boolean
  lastChange: ChangeSpec | null
  // counts are unsupported; digits after a leading 1-9 are swallowed
  countPending: boolean
  changeInsert: PendingChangeInsert | null
}

const OPERATORS: Operator[] = ['d', 'c', 'y']
const MOTION_TARGETS = ['h', 'j', 'k', 'l', '0', '^', '$', 'w', 'b', 'e']
const CLOSER_FOR: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
}
const OPENER_FOR: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
}

function isWordChar(ch: string): boolean
{
  return /[A-Za-z0-9_]/.test(ch)
}

function firstNonBlank(value: string, span: LineSpan): number
{
  let i = span.start
  while (
    i < span.end &&
    (value.charAt(i) === ' ' || value.charAt(i) === '\t')
  )
  {
    i = nextGraphemeOffset(value, i)
  }
  return i
}

// normal-mode cursor sits ON a character; empty lines collapse onto their start
function clampNormal(value: string, offset: number): number
{
  offset = clampGraphemeOffset(value, offset)
  const span = lineSpanAt(value, offset)
  if (span.end === span.start)
  {
    return span.start
  }
  return Math.min(
    Math.max(offset, span.start),
    previousGraphemeOffset(value, span.end)
  )
}

function wordForward(value: string, pos: number): number
{
  const n = value.length
  let i = pos
  if (i < n && isWordChar(value.charAt(i)))
  {
    while (i < n && isWordChar(value.charAt(i)))
    {
      i = nextGraphemeOffset(value, i)
    }
  }
  while (i < n && !isWordChar(value.charAt(i)))
  {
    i = nextGraphemeOffset(value, i)
  }
  return i
}

function wordBackward(value: string, pos: number): number
{
  let i = previousGraphemeOffset(value, pos)
  while (i > 0 && !isWordChar(value.charAt(i)))
  {
    i = previousGraphemeOffset(value, i)
  }
  while (i > 0 && isWordChar(value.charAt(previousGraphemeOffset(value, i))))
  {
    i = previousGraphemeOffset(value, i)
  }
  return Math.max(i, 0)
}

function wordEnd(value: string, pos: number): number | null
{
  const n = value.length
  let i = nextGraphemeOffset(value, pos)
  while (i < n && !isWordChar(value.charAt(i)))
  {
    i = nextGraphemeOffset(value, i)
  }
  if (i >= n)
  {
    return null
  }
  while (
    nextGraphemeOffset(value, i) < n &&
    isWordChar(value.charAt(nextGraphemeOffset(value, i)))
  )
  {
    i = nextGraphemeOffset(value, i)
  }
  return i
}

// exclusive-end inner run around the cursor; a non-word cursor selects its
// separator run but never crosses a newline boundary
function wordRunAround(value: string, pos: number): [number, number]
{
  const n = value.length
  const onWord = pos < n && isWordChar(value.charAt(pos))
  const sep = (i: number): boolean =>
  {
    const ch = value.charAt(i)
    return ch !== '\n' && !isWordChar(ch)
  }
  let lo = pos
  let hi = pos
  if (onWord)
  {
    while (
      lo > 0 &&
      isWordChar(value.charAt(previousGraphemeOffset(value, lo)))
    )
    {
      lo = previousGraphemeOffset(value, lo)
    }
    while (
      nextGraphemeOffset(value, hi) < n &&
      isWordChar(value.charAt(nextGraphemeOffset(value, hi)))
    )
    {
      hi = nextGraphemeOffset(value, hi)
    }
  }
  else
  {
    while (lo > 0 && sep(previousGraphemeOffset(value, lo)))
    {
      lo = previousGraphemeOffset(value, lo)
    }
    while (
      nextGraphemeOffset(value, hi) < n &&
      sep(nextGraphemeOffset(value, hi))
    )
    {
      hi = nextGraphemeOffset(value, hi)
    }
  }
  return [lo, nextGraphemeOffset(value, hi)]
}

// aw extends the inner run by one adjacent space/tab, preferring the right side
function extendToAll(value: string, range: [number, number]): [number, number]
{
  const [lo, hi] = range
  const after = value.charAt(hi)
  if (after === ' ' || after === '\t')
  {
    return [lo, nextGraphemeOffset(value, hi)]
  }
  const previous = previousGraphemeOffset(value, lo)
  const before = lo > 0 ? value.charAt(previous) : ''
  if (before === ' ' || before === '\t')
  {
    return [previous, hi]
  }
  return range
}

// nearest same-kind quote pair on the cursor's line containing the cursor;
// walking pairs left-to-right also admits a cursor parked on either delimiter
function quoteRange(
  value: string,
  pos: number,
  quote: string,
  inclusive: boolean
): [number, number] | null
{
  const idxs: number[] = []
  const span = lineSpanAt(value, pos)
  for (let i = span.start; i < span.end; i = nextGraphemeOffset(value, i))
  {
    const ch = value.charAt(i)
    if (ch === quote)
    {
      idxs.push(i)
    }
  }
  for (let k = 0; k + 1 < idxs.length; k += 2)
  {
    const open = idxs[k]
    const close = idxs[k + 1]
    if (open <= pos && pos <= close)
    {
      return inclusive
        ? [open, nextGraphemeOffset(value, close)]
        : [nextGraphemeOffset(value, open), close]
    }
  }
  return null
}

// nearest balanced bracket pair enclosing the cursor w/ nesting depth counting;
// a cursor resting on an opener binds to that pair directly
function bracketRange(
  value: string,
  pos: number,
  opener: string,
  closer: string,
  inclusive: boolean
): [number, number] | null
{
  let openIdx = -1
  if (value.charAt(Math.min(pos, value.length)) === opener)
  {
    openIdx = pos
  }
  else
  {
    let depth = 0
    for (let i = pos; i > 0;)
    {
      i = previousGraphemeOffset(value, i)
      const ch = value.charAt(i)
      if (ch === closer)
      {
        depth++
      }
      else if (ch === opener)
      {
        if (depth === 0)
        {
          openIdx = i
          break
        }
        depth--
      }
    }
  }
  if (openIdx < 0)
  {
    return null
  }
  let depth = 0
  for (
    let i = nextGraphemeOffset(value, openIdx);
    i < value.length;
    i = nextGraphemeOffset(value, i)
  )
  {
    const ch = value.charAt(i)
    if (ch === opener)
    {
      depth++
    }
    else if (ch === closer)
    {
      if (depth === 0)
      {
        if (i < pos)
        {
          return null
        }
        return inclusive
          ? [openIdx, nextGraphemeOffset(value, i)]
          : [nextGraphemeOffset(value, openIdx), i]
      }
      depth--
    }
  }
  return null
}

// motion-based operator targets stay inside the cursor's own line so charwise
// edits never swallow a newline; text objects resolve exactly wherever they live
function resolveCharRange(
  state: VimState,
  target: string
): [number, number] | null
{
  const { value, cursor } = state
  const span = lineSpanAt(value, cursor)

  switch (target)
  {
    case 'h':
      return cursor > span.start
        ? [Math.max(span.start, previousGraphemeOffset(value, cursor)), cursor]
        : null
    case 'l':
      return [cursor, Math.min(span.end, nextGraphemeOffset(value, cursor))]
    case '$':
      return cursor < span.end ? [cursor, span.end] : null
    case '0':
      return cursor > span.start ? [span.start, cursor] : null
    case '^':
    {
      const fnb = firstNonBlank(value, span)
      return fnb < cursor ? [fnb, cursor] : null
    }
    case 'w':
    {
      const wf = wordForward(value, cursor)
      const nl = value.indexOf('\n', cursor)
      const hi = nl >= 0 && nl < wf ? nl : wf
      return hi > cursor ? [cursor, hi] : null
    }
    case 'e':
    {
      const we = wordEnd(value, cursor)
      if (we === null || we >= span.end || we < cursor)
      {
        return null
      }
      return [cursor, nextGraphemeOffset(value, we)]
    }
    case 'b':
    {
      const wb = wordBackward(value, cursor)
      if (wb < span.start || wb >= cursor)
      {
        return null
      }
      return [wb, cursor]
    }
  }

  if (target.length === 2)
  {
    const scope = target.charAt(0)
    const sel = target.charAt(1)
    const inclusive = scope === 'a'
    if (sel === 'w')
    {
      const range = wordRunAround(value, cursor)
      if (range[1] <= range[0])
      {
        return null
      }
      return inclusive ? extendToAll(value, range) : range
    }
    if (sel === '"' || sel === "'")
    {
      return quoteRange(value, cursor, sel, inclusive)
    }
    const opener = CLOSER_FOR[sel] ?? OPENER_FOR[sel]
    if (opener)
    {
      return bracketRange(value, cursor, opener, CLOSER_FOR[opener], inclusive)
    }
  }
  return null
}

function setRegister(state: VimState, text: string, linewise: boolean): void
{
  state.register = text
  state.registerLinewise = linewise
}

function linewiseText(text: string): string
{
  return text.endsWith('\n') ? text : `${text}\n`
}

// rows a linewise operator covers: its own line (`dd`), or one more below
// (`dj`) or above (`dk`); null when that row does not exist
function linewiseSpan(
  value: string,
  cursor: number,
  target: string
): LineSpan | null
{
  const span = lineSpanAt(value, cursor)
  if (target === 'j')
  {
    if (span.end >= value.length) return null
    return { ...span, end: lineSpanAt(value, span.end + 1).end }
  }
  if (target === 'k')
  {
    if (span.start === 0) return null
    return { ...lineSpanAt(value, span.start - 1), end: span.end }
  }
  return span
}

// applies one completed operator change; returns false when the target fails
// cleanly (no edit, caller just clears any pending state)
function applyOperator(
  state: VimState,
  operator: Operator,
  target: string
): boolean
{
  const { value } = state

  if (target === '' || target === 'j' || target === 'k')
  {
    const span = linewiseSpan(value, state.cursor, target)
    if (!span) return false
    const isLastRow = span.end >= value.length
    let lo = span.start
    let hi = span.end
    if (operator !== 'c')
    {
      if (!isLastRow)
      {
        hi = span.end + 1
      }
      else if (span.start > 0)
      {
        lo = span.start - 1
      }
    }
    // the register holds the line alone, whichever newline the delete takes
    setRegister(state, linewiseText(value.slice(span.start, span.end)), true)
    if (operator === 'y')
    {
      return true
    }
    state.value = value.slice(0, lo) + value.slice(hi)
    if (operator === 'c')
    {
      state.mode = 'insert'
      state.cursor = Math.min(lo, state.value.length)
      return true
    }
    state.cursor = clampNormal(state.value, Math.min(lo, state.value.length))
    return true
  }

  const range = resolveCharRange(state, target)
  if (!range)
  {
    return false
  }
  const [lo, hi] = range
  if (hi <= lo)
  {
    return false
  }
  setRegister(state, value.slice(lo, hi), false)
  if (operator === 'y')
  {
    return true
  }
  state.value = value.slice(0, lo) + value.slice(hi)
  if (operator === 'c')
  {
    state.mode = 'insert'
    state.cursor = lo
    return true
  }
  state.cursor = clampNormal(state.value, lo)
  return true
}

function deleteUnderCursor(state: VimState): void
{
  const span = lineSpanAt(state.value, state.cursor)
  if (state.cursor >= span.end)
  {
    return
  }
  const end = nextGraphemeOffset(state.value, state.cursor)
  setRegister(state, state.value.slice(state.cursor, end), false)
  state.value = state.value.slice(0, state.cursor) + state.value.slice(end)
  state.cursor = clampNormal(state.value, state.cursor)
}

function pasteRegister(state: VimState, after: boolean): void
{
  if (state.register.length === 0)
  {
    return
  }
  const span = lineSpanAt(state.value, state.cursor)
  if (state.registerLinewise)
  {
    const content = state.register.endsWith('\n')
      ? state.register.slice(0, -1)
      : state.register
    const isLastRow = span.end >= state.value.length
    const append = after && isLastRow
    const insertAt = after
      ? isLastRow
        ? state.value.length
        : span.end + 1
      : span.start
    const text = append ? `\n${content}` : `${content}\n`
    state.value =
      state.value.slice(0, insertAt) + text + state.value.slice(insertAt)
    state.cursor = clampNormal(state.value, insertAt + (append ? 1 : 0))
    return
  }
  const insertAt = after
    ? Math.min(nextGraphemeOffset(state.value, state.cursor), span.end)
    : state.cursor
  state.value =
    state.value.slice(0, insertAt) +
    state.register +
    state.value.slice(insertAt)
  state.cursor = clampNormal(
    state.value,
    Math.max(
      insertAt,
      previousGraphemeOffset(state.value, insertAt + state.register.length)
    )
  )
}

// vertical moves preserve the grapheme column inside the target line's bounds
function moveToRow(state: VimState, row: number): void
{
  const starts = buildLineStarts(state.value)
  const offsets = graphemeOffsets(state.value)
  const col =
    offsets.indexOf(state.cursor) -
    offsets.indexOf(lineSpanAt(state.value, state.cursor).start)
  const target = rowSpan(state.value, starts, row)
  const targetOffset =
    offsets[offsets.indexOf(target.start) + col] ?? target.end
  state.cursor = clampNormal(state.value, Math.min(targetOffset, target.end))
}

// a `c` change is repeatable once its INSERT session ends; dot replays it only
// when the session was plain typing at the change point
function recordChange(state: VimState, change: ChangeSpec): void
{
  if (change.operator === 'c' && state.mode === 'insert')
  {
    state.changeInsert = { change, before: state.value, start: state.cursor }
    return
  }
  state.lastChange = change
}

// the text typed since a `c` change; a session that moved the cursor or edited
// outside the inserted run is not replayable and keeps the earlier change
function finishChangeInsert(state: VimState): void
{
  const pending = state.changeInsert
  if (!pending) return
  state.changeInsert = null
  const { before, start } = pending
  const end = start + state.value.length - before.length
  const plainTyping =
    state.cursor === end &&
    end >= start &&
    state.value.slice(0, start) === before.slice(0, start) &&
    state.value.slice(end) === before.slice(start)
  if (plainTyping)
  {
    state.lastChange = {
      ...pending.change,
      text: state.value.slice(start, end),
    }
  }
}

function applyInsertInput(state: VimState, key: VimKey): void
{
  if (key.escape)
  {
    finishChangeInsert(state)
    // exit INSERT moving back one char, never crossing the line's own start
    const span = lineSpanAt(state.value, state.cursor)
    state.mode = 'normal'
    state.cursor = Math.max(
      span.start,
      previousGraphemeOffset(state.value, state.cursor)
    )
    return
  }
  if (key.input && key.input.length > 0)
  {
    state.value =
      state.value.slice(0, state.cursor) +
      key.input +
      state.value.slice(state.cursor)
    state.cursor += key.input.length
    return
  }
  if (key.return)
  {
    state.value =
      state.value.slice(0, state.cursor) +
      '\n' +
      state.value.slice(state.cursor)
    state.cursor++
    return
  }
  if (key.backspace)
  {
    if (state.cursor > 0)
    {
      const start = previousGraphemeOffset(state.value, state.cursor)
      state.value =
        state.value.slice(0, start) + state.value.slice(state.cursor)
      state.cursor = start
    }
    return
  }
  if (key.delete)
  {
    if (state.cursor < state.value.length)
    {
      state.value =
        state.value.slice(0, state.cursor) +
        state.value.slice(nextGraphemeOffset(state.value, state.cursor))
    }
    return
  }
}

function evaluateCmdline(state: VimState): void
{
  const cmd = state.cmdlineText
  state.cmdlineActive = false
  state.cmdlineText = ''
  if (cmd === 'wq' || cmd === 'x')
  {
    state.submitRequested = true
  }
  else if (cmd === 'q' || cmd === 'w')
  {
    // closes without further effect
  }
  else
  {
    state.stickyHint = `not an editor command: ${cmd}`
  }
}

function applyCmdlineInput(state: VimState, key: VimKey): void
{
  if (key.escape)
  {
    state.cmdlineActive = false
    state.cmdlineText = ''
    return
  }
  if (key.return)
  {
    evaluateCmdline(state)
    return
  }
  if (key.backspace)
  {
    state.cmdlineText = state.cmdlineText.slice(
      0,
      previousGraphemeOffset(state.cmdlineText, state.cmdlineText.length)
    )
    if (state.cmdlineText.length === 0)
    {
      state.cmdlineActive = false
    }
    return
  }
  if (key.input && key.input.length > 0)
  {
    state.cmdlineText += key.input
  }
}

function enterInsert(state: VimState, cursor: number): void
{
  state.changeInsert = null
  state.mode = 'insert'
  state.pendingOperator = null
  state.pendingObject = null
  state.pendingG = false
  state.cursor = cursor
}

function applyNormalInput(state: VimState, key: VimKey): void
{
  if (key.escape)
  {
    state.pendingOperator = null
    state.pendingObject = null
    state.pendingG = false
    state.countPending = false
    return
  }
  const ch = key.input && key.input.length > 0 ? key.input : null
  // counts are not supported; swallow them so the `0` in `10x` is not a motion
  if (ch && (/^[1-9]$/.test(ch) || (state.countPending && ch === '0')))
  {
    state.countPending = true
    return
  }
  state.countPending = false
  if (!ch)
  {
    return
  }

  if (state.pendingG)
  {
    state.pendingG = false
    if (ch === 'g')
    {
      moveToRow(state, 0)
      return
    }
    // fall through and process this key as a fresh command
  }

  if (ch === ':')
  {
    state.cmdlineActive = true
    state.cmdlineText = ''
    return
  }

  if (state.pendingOperator)
  {
    const op = state.pendingOperator
    if (!state.pendingObject && (ch === 'i' || ch === 'a'))
    {
      state.pendingObject = ch
      return
    }
    if (state.pendingObject)
    {
      const scope = state.pendingObject
      state.pendingOperator = null
      state.pendingObject = null
      let target: string | null = null
      if (ch === 'w' || ch === '"' || ch === "'")
      {
        target = `${scope}${ch}`
      }
      else
      {
        const opener = OPENER_FOR[ch]
        if (opener)
        {
          target = `${scope}${opener}`
        }
      }
      if (target && applyOperator(state, op, target))
      {
        recordChange(state, { operator: op, target })
      }
      return
    }
    state.pendingOperator = null
    if (ch === op)
    {
      if (applyOperator(state, op, ''))
      {
        recordChange(state, { operator: op, target: '' })
      }
    }
    else if (MOTION_TARGETS.includes(ch))
    {
      if (applyOperator(state, op, ch))
      {
        recordChange(state, { operator: op, target: ch })
      }
    }
    // any other key just cancels the pending operator
    return
  }

  if (ch === '.')
  {
    const change = state.lastChange
    if (change && applyOperator(state, change.operator, change.target))
    {
      if (state.mode === 'insert')
      {
        applyInsertInput(state, { input: change.text ?? '' })
        applyInsertInput(state, { escape: true })
      }
    }
    return
  }

  if (OPERATORS.includes(ch as Operator))
  {
    state.pendingOperator = ch as Operator
    state.pendingObject = null
    return
  }

  switch (ch)
  {
    case 'u':
      state.undoRequested = true
      return
    case 'x':
      deleteUnderCursor(state)
      return
    case 'p':
      pasteRegister(state, true)
      return
    case 'P':
      pasteRegister(state, false)
      return
    case 'i':
      enterInsert(state, state.cursor)
      return
    case 'a':
      {
        const span = lineSpanAt(state.value, state.cursor)
        enterInsert(
          state,
          Math.min(span.end, nextGraphemeOffset(state.value, state.cursor))
        )
      }
      return
    case 'I':
      {
        const span = lineSpanAt(state.value, state.cursor)
        enterInsert(state, firstNonBlank(state.value, span))
      }
      return
    case 'A':
      {
        const span = lineSpanAt(state.value, state.cursor)
        enterInsert(state, span.end)
      }
      return
    case 'o':
    case 'O':
      {
        const span = lineSpanAt(state.value, state.cursor)
        const splitAt = ch === 'o' ? span.end : span.start
        state.value =
          state.value.slice(0, splitAt) + '\n' + state.value.slice(splitAt)
        enterInsert(state, ch === 'o' ? splitAt + 1 : splitAt)
      }
      return
    case 'G':
      moveToRow(state, Number.MAX_SAFE_INTEGER)
      return
    case 'g':
      state.pendingG = true
      return
  }

  if (MOTION_TARGETS.includes(ch))
  {
    const span = lineSpanAt(state.value, state.cursor)
    switch (ch)
    {
      case 'h':
        state.cursor = Math.max(
          span.start,
          previousGraphemeOffset(state.value, state.cursor)
        )
        break
      case 'l':
        state.cursor = clampNormal(
          state.value,
          Math.min(span.end, nextGraphemeOffset(state.value, state.cursor))
        )
        break
      case 'j':
        moveToRow(state, span.row + 1)
        break
      case 'k':
        moveToRow(state, span.row - 1)
        break
      case '0':
        state.cursor = span.start
        break
      case '^':
        state.cursor = firstNonBlank(state.value, span)
        break
      case '$':
        state.cursor =
          span.end > span.start
            ? previousGraphemeOffset(state.value, span.end)
            : span.start
        break
      case 'w':
        state.cursor = clampNormal(
          state.value,
          wordForward(state.value, state.cursor)
        )
        break
      case 'e':
        {
          const we = wordEnd(state.value, state.cursor)
          if (we !== null)
          {
            state.cursor = clampNormal(state.value, we)
          }
        }
        break
      case 'b':
        state.cursor = clampNormal(
          state.value,
          wordBackward(state.value, state.cursor)
        )
        break
    }
  }
}

export function createVimEngine(value: string): VimEngine
{
  const state: VimState = {
    mode: 'normal',
    value,
    cursor: clampNormal(value, 0),
    register: '',
    registerLinewise: false,
    pendingOperator: null,
    pendingObject: null,
    pendingG: false,
    cmdlineActive: false,
    cmdlineText: '',
    stickyHint: null,
    submitRequested: false,
    undoRequested: false,
    lastChange: null,
    countPending: false,
    changeInsert: null,
  }
  return state as unknown as VimEngine
}

// synchronize insert-mode edits made by the shared composer without losing registers
export function syncVimDraft(
  engine: VimEngine,
  value: string,
  cursorOffset: number
): void
{
  const state = engine as unknown as VimState
  state.value = value
  state.cursor =
    state.mode === 'normal'
      ? clampNormal(value, cursorOffset)
      : clampGraphemeOffset(value, cursorOffset, 'forward')
}

export function vimRegister(engine: VimEngine): string
{
  return (engine as unknown as VimState).register
}

// retain cross-prompt yanks after the composer releases its paste payloads
export function materializeVimRegister(
  engine: VimEngine,
  expandText: (value: string) => string
): void
{
  const state = engine as unknown as VimState
  state.register = expandText(state.register)
}

export function vimView(engine: VimEngine): VimView
{
  const state = engine as unknown as VimState
  let statusHint: string | null = null
  if (state.mode === 'insert')
  {
    statusHint = '-- INSERT --'
  }
  else if (state.cmdlineActive)
  {
    statusHint = `:${state.cmdlineText}`
  }
  else if (state.pendingOperator)
  {
    statusHint = state.pendingObject
      ? `${state.pendingOperator}${state.pendingObject}`
      : state.pendingOperator
  }
  else if (state.pendingG)
  {
    statusHint = 'g'
  }
  else
  {
    statusHint = state.stickyHint
  }
  return {
    mode: state.mode,
    value: state.value,
    cursorOffset: state.cursor,
    statusHint,
    submitRequested: state.submitRequested,
    undoRequested: state.undoRequested,
  }
}

export function applyVimInput(engine: VimEngine, key: VimKey): VimView
{
  const state = engine as unknown as VimState
  if (!key.return) state.submitRequested = false
  state.undoRequested = false
  // any incoming keypress dismisses a transient ex-command error hint
  state.stickyHint = null
  if (state.mode === 'insert')
  {
    applyInsertInput(state, key)
  }
  else if (state.cmdlineActive)
  {
    applyCmdlineInput(state, key)
  }
  else
  {
    applyNormalInput(state, key)
  }
  state.cursor =
    state.mode === 'normal'
      ? clampNormal(state.value, state.cursor)
      : clampGraphemeOffset(state.value, state.cursor, 'forward')
  return vimView(engine)
}
