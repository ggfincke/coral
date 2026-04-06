// src/shared/ignored-entries.ts
// canonical noisy project entries shared across context & file discovery

export const COMMON_IGNORED_PROJECT_ENTRIES = new Set([
  '.git',
  'node_modules',
  '.next',
  '.cache',
  'dist',
  'build',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.DS_Store',
  '.idea',
  '.vscode',
  'coverage',
  '.nyc_output',
  '.turbo',
  '.parcel-cache',
])

// clone the shared set so call sites can extend safely
export function createIgnoredEntrySet(extra: Iterable<string> = []): Set<string>
{
  return new Set([...COMMON_IGNORED_PROJECT_ENTRIES, ...extra])
}
