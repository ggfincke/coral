// src/tui/prompt/completion-menu.tsx
// render slash-command and @-file suggestions under the prompt

import { Box, Text } from 'ink'
import { selectionStyle, style } from '../theme.js'
import { padEnd } from '../wrap.js'
import type { CompletionItem, CompletionKind } from './completion.js'
import { fitPromptLine } from './prompt-render.js'

export interface CompletionMenuRow
{
  key: string
  text: string
  selected: boolean
  detail: boolean
}

// one shared row model supplies both rendering and the composer's height
export function buildCompletionMenuRows(
  items: CompletionItem[],
  selectedIndex: number,
  kind: CompletionKind,
  width: number,
  maxRows: number
): CompletionMenuRow[]
{
  const budget = Math.max(0, Math.floor(maxRows))
  if (budget === 0 || items.length === 0) return []
  const selected = Math.max(0, Math.min(selectedIndex, items.length - 1))
  const detail = items[selected]?.detail
  const detailRows = detail && budget > 1 ? 1 : 0
  const resultRows = Math.min(items.length, budget - detailRows)
  const start = Math.max(
    0,
    Math.min(
      selected - Math.floor((resultRows - 1) / 2),
      items.length - resultRows
    )
  )
  const sigil = kind === 'command' ? '/' : '@'
  const rows = items.slice(start, start + resultRows).map((item, index) => ({
    key: item.value,
    text: fitPromptLine(
      `${start + index === selected ? '›' : ' '} ${sigil}${item.label}`,
      width
    ),
    selected: start + index === selected,
    detail: false,
  }))
  if (detailRows)
  {
    rows.push({
      key: 'selected-description',
      text: fitPromptLine(`  ${detail}`, width),
      selected: false,
      detail: true,
    })
  }
  return rows
}

export default function CompletionMenu({
  rows,
  width,
}: {
  rows: CompletionMenuRow[]
  width: number
})
{
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {rows.map((row) => (
        <Box key={row.key} height={1} flexShrink={0}>
          <Text wrap="truncate-end">
            {row.selected
              ? selectionStyle()(padEnd(row.text, width))
              : row.detail
                ? style('muted')(row.text)
                : row.text || ' '}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
