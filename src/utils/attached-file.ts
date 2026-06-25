// src/utils/attached-file.ts
// labeled file/snippet blocks for model prompt assembly

interface FormatAttachedFileBlockOptions
{
  truncated?: boolean
  fence?: 'none' | string
}

// wrap a file body in a labeled block for the model; fence is none or a language tag
export function formatAttachedFileBlock(
  label: string,
  body: string,
  options: FormatAttachedFileBlockOptions = {}
): string
{
  const { truncated = false, fence = 'none' } = options

  if (fence !== 'none')
  {
    return `${label}\n\`\`\`${fence}\n${body}\n\`\`\``
  }

  const suffix = truncated ? ' (truncated)' : ''
  return `===== ${label}${suffix} =====\n${body}`
}
