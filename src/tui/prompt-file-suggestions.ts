// src/tui/prompt-file-suggestions.ts
// prompt file completion cache state helpers

export interface PromptFileSuggestionReset
{
  files: string[]
  filesRequested: boolean
  selectedIndex: number
  dismissed: boolean
}

export function resetPromptFileSuggestions(): PromptFileSuggestionReset
{
  return {
    files: [],
    filesRequested: false,
    selectedIndex: 0,
    dismissed: false,
  }
}
