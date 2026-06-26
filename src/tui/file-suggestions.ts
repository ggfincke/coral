// src/tui/file-suggestions.ts
// project file path suggestions for the @-mention picker

import { collectProjectFiles } from '../shared/project-files.js'
import { isLikelyTextPath } from '../shared/text-paths.js'
export { isLikelyTextPath } from '../shared/text-paths.js'

const MAX_SUGGESTION_FILES = 5_000
const cache = new Map<string, string[]>()

// ignore-aware project file paths (stat-only walk — no file contents read),
// filtered to text-ish files. cached per cwd for the session; new files
// mid-session won't appear until restart
export async function listProjectFiles(cwd: string): Promise<string[]>
{
  const cached = cache.get(cwd)
  if (cached) return cached

  const files = await collectProjectFiles(cwd, {
    maxFiles: MAX_SUGGESTION_FILES,
    includePath: isLikelyTextPath,
  })
  const paths = files.map((file) => file.path)
  cache.set(cwd, paths)
  return paths
}
