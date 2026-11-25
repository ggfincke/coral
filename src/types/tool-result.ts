// src/types/tool-result.ts
// stored tool-result text format shared by the agent writer & transcript rebuilds

// prefix that marks a failed call in stored history; history keeps no flag
const STORED_TOOL_ERROR_PREFIX = 'Error: '

// stored tool message text: the error first, then any output the tool produced
export function formatStoredToolResult(
  output: string,
  error: string | undefined
): string
{
  if (!error) return output
  return output
    ? `${STORED_TOOL_ERROR_PREFIX}${error}\n${output}`
    : `${STORED_TOOL_ERROR_PREFIX}${error}`
}

export interface StoredToolResult
{
  isError: boolean
  // stored text w/o the error prefix, matching what the live view showed
  text: string
}

// a successful output that itself starts w/ the prefix reads as an error;
// accepted since stored messages carry no separate status
export function parseStoredToolResult(content: string): StoredToolResult
{
  return content.startsWith(STORED_TOOL_ERROR_PREFIX)
    ? { isError: true, text: content.slice(STORED_TOOL_ERROR_PREFIX.length) }
    : { isError: false, text: content }
}
