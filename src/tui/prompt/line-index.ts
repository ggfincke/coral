// src/tui/prompt/line-index.ts
// line/cursor mapping for multi-line prompt editing

export interface LinePosition
{
  row: number
  col: number
}

// ascending start offsets of every line: always begins w/ 0
export function buildLineStarts(value: string): number[]
{
  const starts = [0]
  for (let i = 0; i < value.length; i += 1)
  {
    if (value[i] === '\n') starts.push(i + 1)
  }
  return starts
}

// one logical line; end is the offset of its '\n' or value.length
export interface LineSpan
{
  row: number
  start: number
  end: number
}

// span of one row, clamped into the value's rows
export function rowSpan(
  value: string,
  starts: readonly number[],
  row: number
): LineSpan
{
  const clamped = Math.max(0, Math.min(row, starts.length - 1))
  const start = starts[clamped] ?? 0
  const end =
    clamped + 1 < starts.length ? (starts[clamped + 1] ?? 0) - 1 : value.length
  return { row: clamped, start, end }
}

// span of the line that holds offset
export function lineSpanAt(value: string, offset: number): LineSpan
{
  const starts = buildLineStarts(value)
  return rowSpan(value, starts, locateOffset(starts, offset).row)
}

// map a string offset to its zero-based row & column (UTF-16 units)
export function locateOffset(
  starts: readonly number[],
  offset: number
): LinePosition
{
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi)
  {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= offset) lo = mid
    else hi = mid - 1
  }

  const row = Math.min(lo, starts.length - 1)
  const rowStart = starts[row] ?? 0
  return { row, col: offset - rowStart }
}

// inverse of locateOffset; col clamps to the target line's length
export function offsetAt(
  value: string,
  starts: readonly number[],
  position: LinePosition
): number
{
  const span = rowSpan(value, starts, position.row)
  const col = Math.max(0, Math.min(position.col, span.end - span.start))
  return span.start + col
}

// nudge an offset off surrogate-pair middles so vertical moves never split
// one; the cursor lands on the pair's leading half
function snapToCodePointBoundary(value: string, offset: number): number
{
  if (offset <= 0 || offset >= value.length) return offset
  const before = value.charCodeAt(offset - 1)
  const after = value.charCodeAt(offset)
  const splitsPair =
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  return splitsPair ? offset - 1 : offset
}

export interface VerticalMove
{
  offset: number
  // column intent carried across consecutive vertical moves (readline-style)
  preferredCol: number
}

// move the cursor deltaRows up/down while remembering the desired column;
// returns the original offset at first/last-line boundaries
export function verticalMove(
  value: string,
  starts: readonly number[],
  offset: number,
  deltaRows: number,
  preferredCol: number | null
): VerticalMove
{
  const current = locateOffset(starts, offset)
  const col = preferredCol ?? current.col
  const targetRow = current.row + deltaRows

  if (targetRow < 0 || targetRow >= starts.length)
  {
    return { offset, preferredCol: col }
  }

  const span = rowSpan(value, starts, targetRow)
  const rawTarget =
    span.start + Math.max(0, Math.min(col, span.end - span.start))

  return {
    offset: snapToCodePointBoundary(value, rawTarget),
    preferredCol: col,
  }
}
