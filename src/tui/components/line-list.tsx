// src/tui/components/line-list.tsx
// render a pre-built string[] as a vertical Ink column

import { Box, Text } from 'ink'

interface LineListProps
{
  lines: string[]
  dim?: boolean
}

export function LineList({ lines, dim }: LineListProps)
{
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((line, index) => (
        <Box key={index} height={1} flexShrink={0}>
          <Text dimColor={dim} wrap="truncate-end">
            {line || ' '}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
