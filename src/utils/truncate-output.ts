// src/utils/truncate-output.ts
// shared newline-delimited output truncation helpers

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
