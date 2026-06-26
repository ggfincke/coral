// src/tui/line-list.tsx
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
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} dimColor={dim}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
