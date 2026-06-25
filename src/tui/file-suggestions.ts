// src/tui/file-suggestions.ts
// project file path list for the @-mention picker, cached per cwd

import { collectIndexableFiles } from '../retrieval/files.js'

const cache = new Map<string, string[]>()

// common binary file extensions the @-mention picker shouldn't offer; they
// can't attach as text (the read-side NUL guard skips them anyway)
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'tiff',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'wav',
  'flac',
  'ogg',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  'zip',
  'gz',
  'tgz',
  'tar',
  'bz2',
  'xz',
  'rar',
  '7z',
  'pdf',
  'dmg',
  'wasm',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'o',
  'a',
  'obj',
  'class',
  'jar',
  'pyc',
  'pyo',
  'node',
  'sqlite',
  'db',
])

// true unless the path has a known-binary extension; extensionless files
// (Makefile, LICENSE) & text formats (incl. .svg) pass
export function isLikelyTextPath(path: string): boolean
{
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return true
  return !BINARY_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
}

// ignore-aware project file paths (stat-only walk — no file contents read),
// filtered to text-ish files. cached per cwd for the session; new files
// mid-session won't appear until restart
export async function listProjectFiles(cwd: string): Promise<string[]>
{
  const cached = cache.get(cwd)
  if (cached) return cached

  const { unchangedPaths } = await collectIndexableFiles(cwd, () => true)
  const paths = unchangedPaths.filter(isLikelyTextPath)
  cache.set(cwd, paths)
  return paths
}
