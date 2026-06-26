// src/utils/bytes.ts
// human-readable byte size formatting

export function formatBytes(bytes: number, opts?: { space?: boolean }): string
{
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1)
  {
    value /= 1024
    unitIndex += 1
  }

  const sep = opts?.space === false ? '' : ' '
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)}${sep}${units[unitIndex]}`
}
