// src/utils/truncate-output.ts
// shared output truncation: item-count caps and char-budget line-boundary cuts

export interface TruncateOutputOptions
{
  dropEmpty?: boolean
  separator?: string
  buildSuffix?: (shown: number, total: number, label: string) => string
}

// truncate newline-delimited output to a max number of lines/items
export function truncateOutput(
  raw: string,
  maxItems: number,
  label: string,
  options: TruncateOutputOptions = {}
): string
{
  const {
    dropEmpty = true,
    separator = '\n\n',
    buildSuffix = (shown, total, suffixLabel) =>
      `(Showing ${shown} of ${total} ${suffixLabel} — use a more specific pattern to narrow results)`,
  } = options
  const lines = dropEmpty ? raw.split('\n').filter(Boolean) : raw.split('\n')
  const total = lines.length

  if (total <= maxItems) return lines.join('\n')

  const shown = lines.slice(0, maxItems).join('\n')
  const suffix = buildSuffix(maxItems, total, label)

  return shown ? `${shown}${separator}${suffix}` : suffix
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
