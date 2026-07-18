// src/tools/preview.ts
// workspace-aware write_file and edit_file approval previews

import { getCwd } from '../cwd.js'
import { computeDiff } from '../utils/diff.js'
import {
  formatPreviewSkipMessage,
  readRequiredTextFile,
  readOptionalPreviousTextFile,
} from '../utils/file-read.js'
import { applyEdit } from './edit-operation.js'
import { checkWorkspacePath } from '../shared/workspace-path.js'

export type ToolDiffPreview =
  { kind: 'diff'; diff: string } | { kind: 'message'; message: string }

export interface ToolDiffPreviewOptions
{
  cwd?: string
  allowOutsideWorkspace?: boolean
}

function diffPreview(diff: string | null): ToolDiffPreview | null
{
  return diff ? { kind: 'diff', diff } : null
}

// compute an approval diff without touching disk; null means no preview
export async function previewToolDiff(
  toolName: string,
  args: Record<string, unknown>,
  options: ToolDiffPreviewOptions = {}
): Promise<ToolDiffPreview | null>
{
  try
  {
    const cwd = options.cwd ?? getCwd()
    if (toolName === 'write_file')
    {
      const allowed = await checkWorkspacePath(
        cwd,
        args.path as string | undefined,
        options.allowOutsideWorkspace === true
      )
      if (!allowed.ok)
      {
        return { kind: 'message', message: `Preview skipped: ${allowed.error}` }
      }

      const before = await readOptionalPreviousTextFile(allowed.path)
      if (!before.ok)
      {
        return { kind: 'message', message: formatPreviewSkipMessage(before) }
      }
      return diffPreview(
        computeDiff(before.content, String(args.content ?? ''))
      )
    }

    if (toolName === 'edit_file')
    {
      const allowed = await checkWorkspacePath(
        cwd,
        args.path as string | undefined,
        options.allowOutsideWorkspace === true
      )
      if (!allowed.ok)
      {
        return { kind: 'message', message: `Preview skipped: ${allowed.error}` }
      }

      const before = await readRequiredTextFile(allowed.path)
      if (!before.ok)
      {
        return { kind: 'message', message: formatPreviewSkipMessage(before) }
      }
      const result = applyEdit(
        before.content,
        String(args.old_string ?? ''),
        String(args.new_string ?? ''),
        Boolean(args.replace_all)
      )
      return result.ok
        ? diffPreview(computeDiff(before.content, result.after))
        : null
    }
  }
  catch
  {
    // preview failures must never block the approval prompt
  }

  return null
}
