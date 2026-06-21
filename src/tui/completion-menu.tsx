// src/tui/completion-menu.tsx
// dropdown of slash-command / @-file suggestions rendered under the prompt

import { Box, Text } from 'ink'
import { inkColor } from './theme.js'
import type { CompletionItem, CompletionKind } from './completion.js'

export interface CompletionMenuProps
{
  items: CompletionItem[]
  selectedIndex: number
  kind: CompletionKind
}

export default function CompletionMenu({
  items,
  selectedIndex,
  kind,
}: CompletionMenuProps)
{
  const sigil = kind === 'command' ? '/' : '@'

  return (
    <Box flexDirection="column">
      {items.map((item, index) =>
      {
        const selected = index === selectedIndex
        const marker = selected ? '›' : ' '
        const color = selected ? inkColor('accent') : undefined

        return (
          <Box key={item.value}>
            <Text bold={selected} color={color}>
              {` ${marker} ${sigil}${item.label}`}
            </Text>
            {item.detail ? (
              <Text color={inkColor('muted')}>{`  ${item.detail}`}</Text>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}
