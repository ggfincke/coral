// src/tui/transcript/diff.ts
// render unified diffs as tinted gutter rows w/ word pairing & side-by-side

import { diffWords } from 'diff'
import chalk, { type ChalkInstance } from 'chalk'
import { getTheme, style, type Role } from '../theme.js'
import { padEnd, visibleWidth } from '../wrap.js'
import { sanitizeUntrustedText } from './sanitize.js'

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// two panes only pay off once both fit beside the shared gutter
const SIDE_BY_SIDE_MIN_WIDTH = 120
const WORD_DIFF_MAX_CHARS = 4_096
const WORD_DIFF_MAX_EDITS = 128
const WORD_DIFF_BUDGET_MS = 8

// style file-level git output lines without a gutter or line count
function isFileHeader(line: string): boolean
{
  return (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode')
  )
}

// widest line number across all hunks -> gutter column width
function gutterWidth(lines: string[]): number
{
  let max = 0
  for (const line of lines)
  {
    const match = HUNK_HEADER.exec(line)
    if (!match) continue
    const oldEnd = Number(match[1]) + Number(match[2] ?? 1)
    const newEnd = Number(match[3]) + Number(match[4] ?? 1)
    max = Math.max(max, oldEnd, newEnd)
  }
  return Math.max(String(max).length, 2)
}

// background chalk instance for a theme role, resolved at call time
function bgStyle(role: Role): ChalkInstance
{
  const color = getTheme().roles[role]
  if ('ansi' in color)
  {
    // retain the terminal's default background for default-colored line numbers
    if (role === 'gutter') return chalk
    const key = `bg${color.ansi[0]!.toUpperCase()}${color.ansi.slice(1)}`
    return (chalk as unknown as Record<string, ChalkInstance>)[key]!
  }
  return chalk.bgRgb(color.r, color.g, color.b)
}

// slice plain text to maxWidth visible columns, code-point & wide-char safe
function sliceToWidth(text: string, maxWidth: number): string
{
  let out = ''
  let width = 0
  for (const ch of Array.from(text))
  {
    const w = visibleWidth(ch)
    if (width + w > maxWidth) break
    out += ch
    width += w
  }
  return out
}

// truncate raw text to fit and mark the cut with an ellipsis; measures by
// visible width so CJK and other double-width text cannot overflow the budget
function fitContent(
  raw: string,
  maxWidth: number
): { text: string; cut: boolean }
{
  if (visibleWidth(raw) <= maxWidth) return { text: raw, cut: false }
  return { text: sliceToWidth(raw, Math.max(maxWidth - 1, 1)), cut: true }
}

type RowKind = 'add' | 'del' | 'ctx'

interface DiffRow
{
  kind: RowKind
  // raw content including the leading sign character
  text: string
  oldNum?: number
  newNum?: number
}

// one emphasized-or-plain fragment of a paired row body
interface CellSegment
{
  text: string
  emph: boolean
}

// adjacent -/+ rows share a group for side-by-side display & word emphasis
interface PairGroup
{
  left?: DiffRow
  right?: DiffRow
  leftCells?: CellSegment[]
  rightCells?: CellSegment[]
}

// literal rows split runs of content rows so pairing never crosses hunk or
// header boundaries
type Item = { type: 'literal'; raw: string } | { type: 'rows'; rows: DiffRow[] }

// parse the unified text into literals and per-hunk content-row runs while
// tracking old/new line numbers exactly like the single-pass renderer did
function parseItems(rawLines: string[]): Item[]
{
  const items: Item[] = []
  let run: DiffRow[] | null = null
  const flush = () =>
  {
    if (!run) return
    items.push({ type: 'rows', rows: run })
    run = null
  }

  let oldLine = 0
  let newLine = 0
  for (const raw of rawLines)
  {
    const hunk = HUNK_HEADER.exec(raw)
    if (hunk)
    {
      flush()
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      items.push({ type: 'literal', raw })
      continue
    }

    if (isFileHeader(raw))
    {
      flush()
      items.push({ type: 'literal', raw })
      continue
    }

    if (raw.startsWith('+'))
    {
      run ??= []
      run.push({ kind: 'add', text: raw, newNum: newLine++ })
      continue
    }

    if (raw.startsWith('-'))
    {
      run ??= []
      run.push({ kind: 'del', text: raw, oldNum: oldLine++ })
      continue
    }

    if (raw.startsWith(' ') || raw === '')
    {
      run ??= []
      run.push({ kind: 'ctx', text: raw, oldNum: oldLine++, newNum: newLine++ })
      continue
    }

    // preserve no-newline markers, truncation markers, and other meta lines
    flush()
    items.push({ type: 'literal', raw })
  }
  flush()
  return items
}

// jsdiff word segmentation for an adjacent -/+ pair; undefined when the
// tokens do not reconstruct both originals exactly (fallback -> plain rows)
function wordSegments(
  oldBody: string,
  newBody: string,
  deadline: number
): [CellSegment[], CellSegment[]] | undefined
{
  if (
    oldBody.length + newBody.length > WORD_DIFF_MAX_CHARS ||
    Date.now() >= deadline
  )
  {
    return undefined
  }
  let parts: ReturnType<typeof diffWords> | undefined
  try
  {
    parts = diffWords(oldBody, newBody, {
      maxEditLength: WORD_DIFF_MAX_EDITS,
      timeout: Math.max(1, deadline - Date.now()),
    })
  }
  catch
  {
    return undefined
  }
  if (!parts) return undefined

  const kept = parts
    .filter((p) => !p.added)
    .map((p) => p.value)
    .join('')
  const added = parts
    .filter((p) => !p.removed)
    .map((p) => p.value)
    .join('')
  if (kept !== oldBody || added !== newBody) return undefined

  return [
    parts
      .filter((p) => !p.added)
      .map((p) => ({ text: p.value, emph: p.removed })),
    parts
      .filter((p) => !p.removed)
      .map((p) => ({ text: p.value, emph: p.added })),
  ]
}

// pair consecutive removal/addition runs by row, leaving extras single-sided
function groupRows(rows: DiffRow[], deadline: number): PairGroup[]
{
  const groups: PairGroup[] = []
  for (let i = 0; i < rows.length;)
  {
    const row = rows[i]!
    if (row.kind === 'del')
    {
      const removed: DiffRow[] = []
      const added: DiffRow[] = []
      while (rows[i]?.kind === 'del') removed.push(rows[i++]!)
      while (rows[i]?.kind === 'add') added.push(rows[i++]!)
      for (
        let pair = 0;
        pair < Math.max(removed.length, added.length);
        pair++
      )
      {
        const left = removed[pair]
        const right = added[pair]
        const cells =
          left && right
            ? wordSegments(left.text.slice(1), right.text.slice(1), deadline)
            : undefined
        groups.push({
          left,
          right,
          ...(cells ? { leftCells: cells[0], rightCells: cells[1] } : {}),
        })
      }
      continue
    }

    groups.push(row.kind === 'add' ? { right: row } : { left: row })
    i += 1
  }
  return groups
}

// resolve the pane contents of a group; context rows show in both panes
function paneSides(group: PairGroup): {
  left: DiffRow | null
  right: DiffRow | null
  leftCells?: CellSegment[]
  rightCells?: CellSegment[]
}
{
  if (group.left?.kind === 'ctx')
  {
    return { left: group.left, right: group.left }
  }
  return {
    left: group.left ?? null,
    right: group.right ?? null,
    leftCells: group.leftCells,
    rightCells: group.rightCells,
  }
}

// foreground paint of cell segments; emphasized fragments go bold
function paintSegments(cells: CellSegment[], fg: ChalkInstance): string
{
  return cells.map((c) => (c.emph ? fg.bold(c.text) : fg(c.text))).join('')
}

// hard-flow segments into visual lines of <= maxWidth columns (CJK-safe);
// local to this renderer because wrapLines assumes one shared indent
function flowCells(cells: CellSegment[], maxWidth: number): CellSegment[][]
{
  const lines: CellSegment[][] = [[]]
  let width = 0
  for (const seg of cells)
  {
    for (const ch of Array.from(seg.text))
    {
      const w = visibleWidth(ch)
      if (width > 0 && width + w > maxWidth)
      {
        lines.push([])
        width = 0
      }
      const line = lines[lines.length - 1]!
      const last = line[line.length - 1]
      if (last && last.emph === seg.emph) last.text += ch
      else line.push({ text: ch, emph: seg.emph })
      width += w
    }
  }
  return lines
}

// foreground role for a row body
function bodyFg(kind: RowKind): ChalkInstance
{
  if (kind === 'add') return style('success')
  if (kind === 'del') return style('error')
  return chalk.dim
}

// background tint for a row body; context stays untinted
function bodyBg(kind: RowKind): ChalkInstance | null
{
  const roles = getTheme().roles
  const foreground = kind === 'add' ? roles.success : roles.error
  const background = kind === 'add' ? roles.diffAddBg : roles.diffRemoveBg
  // inherited ANSI palettes cannot distinguish identical foreground/background
  if (
    'ansi' in foreground &&
    'ansi' in background &&
    foreground.ansi === background.ansi
  )
  {
    return null
  }
  if (kind === 'add') return bgStyle('diffAddBg')
  if (kind === 'del') return bgStyle('diffRemoveBg')
  return null
}

// unified-mode rows for one pair group; pairs stay stacked like classic diffs
function renderUnifiedGroup(
  group: PairGroup,
  contentWidth: number,
  num: (n: number | undefined) => string
): string[]
{
  const out: string[] = []
  const sides: Array<{ row: DiffRow; cells?: CellSegment[] }> = []
  if (group.left) sides.push({ row: group.left, cells: group.leftCells })
  if (group.right && group.right !== group.left)
  {
    sides.push({ row: group.right, cells: group.rightCells })
  }

  for (const { row, cells } of sides)
  {
    const fg = bodyFg(row.kind)
    let body: string
    let cut = false
    if (cells && visibleWidth(row.text) <= contentWidth)
    {
      // cells hold the sign-stripped body; unified rows keep the +/- sign
      body = row.text.slice(0, 1) + paintSegments(cells, fg)
    }
    else
    {
      // truncation semantics preserved: over-long rows cut w/ an ellipsis
      const fit = fitContent(row.text, contentWidth)
      body = fg(fit.text)
      cut = fit.cut
    }

    const padded = cut ? body : padEnd(body, contentWidth)
    const bg = bodyBg(row.kind)
    const bodyCol = bg ? bg(padded) : padded
    const gutter = bgStyle('gutter')(
      chalk.dim(`${num(row.oldNum)} ${num(row.newNum)}`)
    )
    out.push(`${gutter} ${bodyCol}${cut ? chalk.dim('…') : ''}`)
  }
  return out
}

// side-by-side rows for one pair group; both panes wrap independently inside
// a shared budget and continuation rows keep their side's tint
function renderSideBySideGroup(
  group: PairGroup,
  paneWidth: number,
  num: (n: number | undefined) => string
): string[]
{
  const { left, right, leftCells, rightCells } = paneSides(group)

  const cellLines = (
    row: DiffRow | null,
    cells: CellSegment[] | undefined
  ): CellSegment[][] =>
  {
    const source = cells ?? [{ text: row?.text ?? '', emph: false }]
    return flowCells(source, paneWidth)
  }

  const leftLines = cellLines(left, leftCells)
  const rightLines = cellLines(right, rightCells)
  const height = Math.max(leftLines.length, rightLines.length, 1)

  const gutterText = `${num(left?.oldNum)} ${num(right?.newNum)}`
  const out: string[] = []
  for (let k = 0; k < height; k++)
  {
    const panes = [
      { row: left, lines: leftLines },
      { row: right, lines: rightLines },
    ].map(({ row, lines }) =>
    {
      const fg = row ? bodyFg(row.kind) : chalk.dim
      const painted = paintSegments(lines[k] ?? [], fg)
      const bg = row ? bodyBg(row.kind) : null
      return bg ? bg(padEnd(painted, paneWidth)) : padEnd(painted, paneWidth)
    })
    out.push(
      `${bgStyle('gutter')(chalk.dim(gutterText))} ${panes[0]} ${panes[1]}`
    )
  }
  return out
}

// render unified diff text (single-file tool diffs or full git output) into
// styled lines: tinted two-column gutter, +/- sign colors, add/remove row
// backgrounds, word-level emphasis on adjacent -/+ pairs, and a two-pane
// layout when the viewport is wide enough
export function renderUnifiedDiff(unified: string, width: number): string[]
{
  const wordDiffDeadline = Date.now() + WORD_DIFF_BUDGET_MS
  const rawLines = sanitizeUntrustedText(unified).split('\n')
  const numWidth = gutterWidth(rawLines)
  const gutterCols = numWidth * 2 + 1
  const sideBySide = width > SIDE_BY_SIDE_MIN_WIDTH
  // panes sit either side of two separator spaces w/ the shared gutter
  const contentWidth = sideBySide
    ? Math.max(Math.floor((width - gutterCols - 2) / 2), 8)
    : Math.max(width - gutterCols - 1, 8)
  // pad a line number into the gutter column
  const num = (n: number | undefined) =>
    n === undefined ? ' '.repeat(numWidth) : String(n).padStart(numWidth)

  const result: string[] = []
  for (const item of parseItems(rawLines))
  {
    if (item.type === 'literal')
    {
      if (HUNK_HEADER.test(item.raw))
      {
        result.push(style('code')(item.raw))
      }
      else if (isFileHeader(item.raw))
      {
        result.push(chalk.bold(item.raw))
      }
      else
      {
        result.push(chalk.dim(item.raw))
      }
      continue
    }

    const groups = groupRows(item.rows, wordDiffDeadline)
    if (sideBySide)
    {
      for (const group of groups)
      {
        result.push(...renderSideBySideGroup(group, contentWidth, num))
      }
    }
    else
    {
      // preserve unified row order even when word emphasis pairs distant rows
      const segments = new Map<DiffRow, CellSegment[] | undefined>()
      for (const group of groups)
      {
        if (group.left) segments.set(group.left, group.leftCells)
        if (group.right) segments.set(group.right, group.rightCells)
      }
      for (const row of item.rows)
      {
        result.push(
          ...renderUnifiedGroup(
            { left: row, leftCells: segments.get(row) },
            contentWidth,
            num
          )
        )
      }
    }
  }

  return result
}
