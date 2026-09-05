// src/tui/prompt/vim.ts
// pure vi-modal editing engine for the prompt composer

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
  lastChange: ChangeSpec | null
}

interface LineSpan
{
  row: number
  start: number
  // offset of the line's '\n' or value.length
  end: number
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

function lineStartsOf(value: string): number[]
{
  const starts = [0]
  for (let i = 0; i < value.length; i++)
  {
    if (value.charAt(i) === '\n')
    {
      starts.push(i + 1)
    }
  }
  return starts
}

function locateLine(starts: number[], offset: number): number
{
  let row = 0
  for (let i = 1; i < starts.length; i++)
  {
    if (starts[i] <= offset)
    {
      row = i
    }
  }
  return row
}

function lineSpan(value: string, starts: number[], row: number): LineSpan
{
  const start = starts[row]
  const nextStart = row + 1 < starts.length ? starts[row + 1] : value.length
  return {
    row,
    start,
    end: row + 1 < starts.length ? nextStart - 1 : value.length,
  }
}

function firstNonBlank(value: string, span: LineSpan): number
{
  let i = span.start
  while (
    i < span.end &&
    (value.charAt(i) === ' ' || value.charAt(i) === '\t')
  )
  {
    i++
  }
  return i
}

// normal-mode cursor sits ON a character; empty lines collapse onto their start
function clampNormal(value: string, offset: number): number
{
  const starts = lineStartsOf(value)
  const span = lineSpan(value, starts, locateLine(starts, offset))
  if (span.end === span.start)
  {
    return span.start
  }
  return Math.min(Math.max(offset, span.start), span.end - 1)
}

function wordForward(value: string, pos: number): number
{
  const n = value.length
  let i = pos
  if (i < n && isWordChar(value.charAt(i)))
  {
    while (i < n && isWordChar(value.charAt(i)))
    {
      i++
    }
  }
  while (i < n && !isWordChar(value.charAt(i)))
  {
    i++
  }
  return i
}

function wordBackward(value: string, pos: number): number
{
  let i = Math.min(pos, value.length) - 1
  while (i >= 0 && !isWordChar(value.charAt(i)))
  {
    i--
  }
  while (i > 0 && isWordChar(value.charAt(i - 1)))
  {
    i--
  }
  return Math.max(i, 0)
}

function wordEnd(value: string, pos: number): number | null
{
  const n = value.length
  let i = pos + 1
  while (i < n && !isWordChar(value.charAt(i)))
  {
    i++
  }
  if (i >= n)
  {
    return null
  }
  while (i + 1 < n && isWordChar(value.charAt(i + 1)))
  {
    i++
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
    while (lo > 0 && isWordChar(value.charAt(lo - 1)))
    {
      lo--
    }
    while (hi + 1 < n && isWordChar(value.charAt(hi + 1)))
    {
      hi++
    }
  }
  else
  {
    while (lo > 0 && sep(lo - 1))
    {
      lo--
    }
    while (hi + 1 < n && sep(hi + 1))
    {
      hi++
    }
  }
  return [lo, hi + 1]
}

// aw extends the inner run by one adjacent space/tab, preferring the right side
function extendToAll(value: string, range: [number, number]): [number, number]
{
  const [lo, hi] = range
  const after = value.charAt(hi)
  if (after === ' ' || after === '\t')
  {
    return [lo, hi + 1]
  }
  const before = lo > 0 ? value.charAt(lo - 1) : ''
  if (before === ' ' || before === '\t')
  {
    return [lo - 1, hi]
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
  const starts = lineStartsOf(value)
  const span = lineSpan(value, starts, locateLine(starts, pos))
  for (let i = span.start; i < span.end; i++)
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
      return inclusive ? [open, close + 1] : [open + 1, close]
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
    for (let i = pos - 1; i >= 0; i--)
    {
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
  for (let i = openIdx + 1; i < value.length; i++)
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
        return inclusive ? [openIdx, i + 1] : [openIdx + 1, i]
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
  const starts = lineStartsOf(value)
  const span = lineSpan(value, starts, locateLine(starts, cursor))

  switch (target)
  {
    case 'h':
      return cursor > span.start
        ? [Math.max(span.start, cursor - 1), cursor]
        : null
    case 'l':
      return [cursor, Math.min(span.end, cursor + 1)]
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
      return [cursor, we + 1]
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

// applies one completed operator change; returns false when the target fails
// cleanly (no edit, caller just clears any pending state)
function applyOperator(
  state: VimState,
  operator: Operator,
  target: string
): boolean
{
  const { value } = state
  const starts = lineStartsOf(value)
  const row = locateLine(starts, state.cursor)
  const span = lineSpan(value, starts, row)
  const isLastRow = row + 1 >= starts.length

  if (target === '')
  {
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
    setRegister(state, linewiseText(value.slice(lo, hi)), true)
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
  const starts = lineStartsOf(state.value)
  const span = lineSpan(state.value, starts, locateLine(starts, state.cursor))
  if (state.cursor >= span.end)
  {
    return
  }
  setRegister(state, state.value.charAt(state.cursor), false)
  state.value =
    state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1)
  state.cursor = clampNormal(state.value, state.cursor)
}

function pasteRegister(state: VimState, after: boolean): void
{
  if (state.register.length === 0)
  {
    return
  }
  const starts = lineStartsOf(state.value)
  const span = lineSpan(state.value, starts, locateLine(starts, state.cursor))
  if (state.registerLinewise)
  {
    const content = state.register.endsWith('\n')
      ? state.register.slice(0, -1)
      : state.register
    const isLastRow = span.row + 1 >= starts.length
    const insertAt = isLastRow ? state.value.length : span.end + 1
    const text = isLastRow ? `\n${content}` : `${content}\n`
    state.value =
      state.value.slice(0, insertAt) + text + state.value.slice(insertAt)
    state.cursor = clampNormal(state.value, insertAt)
    return
  }
  const insertAt = after ? Math.min(state.cursor + 1, span.end) : state.cursor
  state.value =
    state.value.slice(0, insertAt) +
    state.register +
    state.value.slice(insertAt)
  state.cursor = clampNormal(
    state.value,
    Math.max(insertAt, insertAt + state.register.length - 1)
  )
}

// vertical move keeps the column, clamped into the target line's bounds
function moveToRow(state: VimState, row: number): void
{
  const starts = lineStartsOf(state.value)
  const targetRow = Math.min(Math.max(row, 0), starts.length - 1)
  const col = state.cursor - starts[locateLine(starts, state.cursor)]
  const target = lineSpan(state.value, starts, targetRow)
  state.cursor = Math.min(
    target.start + col,
    Math.max(target.start, target.end - 1)
  )
}

function applyInsertInput(state: VimState, key: VimKey): void
{
  if (key.escape)
  {
    // exit INSERT moving back one char, never crossing the line's own start
    const starts = lineStartsOf(state.value)
    const span = lineSpan(state.value, starts, locateLine(starts, state.cursor))
    state.mode = 'normal'
    state.cursor = Math.max(span.start, state.cursor - 1)
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
      state.value =
        state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor)
      state.cursor--
    }
    return
  }
  if (key.delete)
  {
    if (state.cursor < state.value.length)
    {
      state.value =
        state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1)
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
    state.cmdlineText = state.cmdlineText.slice(0, -1)
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
    return
  }
  const ch = key.input && key.input.length > 0 ? key.input : null
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
        state.lastChange = { operator: op, target }
      }
      return
    }
    state.pendingOperator = null
    if (ch === op)
    {
      if (applyOperator(state, op, ''))
      {
        state.lastChange = { operator: op, target: '' }
      }
    }
    else if (MOTION_TARGETS.includes(ch))
    {
      if (applyOperator(state, op, ch))
      {
        state.lastChange = { operator: op, target: ch }
      }
    }
    // any other key just cancels the pending operator
    return
  }

  if (ch === '.')
  {
    if (state.lastChange)
    {
      const { operator, target } = state.lastChange
      if (applyOperator(state, operator, target))
      {
        state.lastChange = { operator, target }
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
        const starts = lineStartsOf(state.value)
        const span = lineSpan(
          state.value,
          starts,
          locateLine(starts, state.cursor)
        )
        enterInsert(state, Math.min(span.end, state.cursor + 1))
      }
      return
    case 'I':
      {
        const starts = lineStartsOf(state.value)
        const span = lineSpan(
          state.value,
          starts,
          locateLine(starts, state.cursor)
        )
        enterInsert(state, firstNonBlank(state.value, span))
      }
      return
    case 'A':
      {
        const starts = lineStartsOf(state.value)
        const span = lineSpan(
          state.value,
          starts,
          locateLine(starts, state.cursor)
        )
        enterInsert(state, span.end)
      }
      return
    case 'o':
    case 'O':
      {
        const starts = lineStartsOf(state.value)
        const span = lineSpan(
          state.value,
          starts,
          locateLine(starts, state.cursor)
        )
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
    const starts = lineStartsOf(state.value)
    const span = lineSpan(state.value, starts, locateLine(starts, state.cursor))
    switch (ch)
    {
      case 'h':
        state.cursor = Math.max(span.start, state.cursor - 1)
        break
      case 'l':
        state.cursor = Math.min(span.end - 1, state.cursor + 1)
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
        state.cursor = span.end > span.start ? span.end - 1 : span.start
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
    lastChange: null,
  }
  return state as unknown as VimEngine
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
  }
}

export function applyVimInput(engine: VimEngine, key: VimKey): VimView
{
  const state = engine as unknown as VimState
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
  return vimView(engine)
}
