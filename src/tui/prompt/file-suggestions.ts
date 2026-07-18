// src/tui/prompt/file-suggestions.ts
// project file path suggestions for the @-mention picker

import { collectProjectFiles } from '../../shared/project-files.js'
import { isLikelyTextPath } from '../../shared/text-paths.js'
export { isLikelyTextPath } from '../../shared/text-paths.js'

const MAX_SUGGESTION_FILES = 5_000

// collect ignore-aware text-ish paths w/o reading file contents
export async function collectProjectFileSuggestions(
  cwd: string,
  signal?: AbortSignal
): Promise<string[]>
{
  const files = await collectProjectFiles(cwd, {
    maxFiles: MAX_SUGGESTION_FILES,
    includePath: isLikelyTextPath,
    signal,
  })
  signal?.throwIfAborted()
  return files.map((file) => file.path)
}

// retain the original collector name for framework-neutral callers
export const listProjectFiles = collectProjectFileSuggestions
