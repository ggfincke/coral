// src/utils/truncate-output.ts
// shared output truncation: item-count caps and char-budget line-boundary cuts

/**
 * Keeps the first `maxItems` non-empty lines of streamed text and counts the
 * rest, so a huge stream costs only the page it shows. Once a line would push
 * retained text past `maxChars`, no further line is kept and the note names
 * how many were actually shown.
 */
export class ItemPage
{
  private readonly shown: string[] = []
  private retainedChars = 0
  private capped = false
  private line = ''
  private lineHasText = false
  private total = 0

  constructor(
    private readonly maxItems: number,
    private readonly label: string,
    private readonly maxChars = Infinity
  )
  {}

  append(text: string): this
  {
    let start = 0
    while (true)
    {
      const end = text.indexOf('\n', start)
      this.extendLine(end === -1 ? text.slice(start) : text.slice(start, end))
      if (end === -1) return this
      this.endLine()
      start = end + 1
    }
  }

  // the page as `truncateOutput` formats it, with a Showing-N-of-M note
  finish(): string
  {
    this.endLine()
    const shown = this.shown.join('\n')
    if (this.shown.length === this.total) return shown

    const suffix = `(Showing ${this.shown.length} of ${this.total} ${this.label} — use a more specific pattern to narrow results)`

    return shown ? `${shown}\n\n${suffix}` : suffix
  }

  private extendLine(piece: string): void
  {
    if (!piece) return
    this.lineHasText = true
    // a line past the page or the char cap is only counted
    if (this.capped || this.total >= this.maxItems) return
    if (this.retainedChars + this.line.length + piece.length > this.maxChars)
    {
      this.capped = true
      this.line = ''
      return
    }
    this.line += piece
  }

  private endLine(): void
  {
    if (this.lineHasText)
    {
      this.total++
      if (!this.capped && this.total <= this.maxItems)
      {
        this.shown.push(this.line)
        this.retainedChars += this.line.length
      }
    }
    this.line = ''
    this.lineHasText = false
  }
}

// truncate newline-delimited output to a max number of non-empty lines/items
export function truncateOutput(
  raw: string,
  maxItems: number,
  label: string
): string
{
  return new ItemPage(maxItems, label).append(raw).finish()
}

// shared marker after a head-truncated tool or MCP result
export function truncationFooter(omitted: number, total: number): string
{
  return (
    `[output truncated: ${omitted} of ${total} chars omitted` +
    ` — narrow the scope (e.g. diff a specific path) to see the rest]`
  )
}

interface LineBoundaryTruncation
{
  head: string
  omitted: number
  truncated: boolean
}

// head-truncate to a char budget, backing off to the last line boundary so a
// half-line is never emitted
export function truncateToLineBoundary(
  text: string,
  maxChars: number
): LineBoundaryTruncation
{
  if (text.length <= maxChars)
  {
    return { head: text, omitted: 0, truncated: false }
  }

  const slice = text.slice(0, maxChars)
  const lastNewline = slice.lastIndexOf('\n')
  const head = lastNewline > 0 ? slice.slice(0, lastNewline) : slice
  return { head, omitted: text.length - head.length, truncated: true }
}

// keep a bounded head+tail of oversized output for in-memory display; the
// middle is genuinely gone (mirrors the session persistence ceiling's spirit)
export interface BoundedOutput
{
  text: string
  omittedChars: number
}

export function capStoredOutput(
  text: string,
  maxChars = 100_000
): BoundedOutput
{
  if (!Number.isSafeInteger(maxChars) || maxChars < 0)
  {
    throw new RangeError('maxChars must be a non-negative safe integer')
  }
  if (text.length <= maxChars)
  {
    return { text, omittedChars: 0 }
  }

  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = maxChars - headChars
  const omittedChars = text.length - maxChars
  return {
    text:
      text.slice(0, headChars) +
      `\n…[${omittedChars} chars not retained]…\n` +
      text.slice(text.length - tailChars),
    omittedChars,
  }
}
