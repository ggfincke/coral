// src/shared/ignored-entries.ts
// shared noisy project entries

const COMMON_IGNORED_PROJECT_ENTRIES = new Set([
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

// return a copy so callers can extend the defaults safely
export function createIgnoredEntrySet(
  extra: Iterable<string> = []
): Set<string>
{
  return new Set([...COMMON_IGNORED_PROJECT_ENTRIES, ...extra])
}
