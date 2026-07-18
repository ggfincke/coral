// src/shared/text-paths.ts
// text-file path heuristics

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

// accept paths without known binary extensions, including extensionless files
// such as Makefile and LICENSE and text formats such as .svg
export function isLikelyTextPath(path: string): boolean
{
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return true
  return !BINARY_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
}
