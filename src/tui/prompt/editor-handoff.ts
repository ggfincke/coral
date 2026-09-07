// src/tui/prompt/editor-handoff.ts
// hand the prompt draft to an external $EDITOR process

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface HandoffEnv
{
  VISUAL?: string
  EDITOR?: string
}

// VISUAL wins over EDITOR (POSIX convention); vi is the portable floor
export function resolveEditorCommand(env: HandoffEnv): string | null
{
  const visual = env.VISUAL?.trim()
  if (visual) return visual
  const editor = env.EDITOR?.trim()
  if (editor) return editor
  if (process.platform === 'win32') return null
  return 'vi'
}

// EDITOR may carry flags ('code -w'); a plain space split covers the common
// cases — quoted arguments in EDITOR are a documented limitation
export function splitEditorCommand(command: string): string[]
{
  return command.split(/\s+/).filter(Boolean)
}

export function buildEditorArgs(command: string, filePath: string): string[]
{
  // many editors need an explicit "wait for close" flag when spawned bare;
  // users who need more configure VISUAL w/ the flag themselves
  const parts = splitEditorCommand(command)
  const base = parts[0] ?? ''
  const needsWaitFlag = base.endsWith('code') && parts.length === 1
  return [...parts.slice(1), ...(needsWaitFlag ? ['-w'] : []), filePath]
}

// an empty or unchanged result cancels: the caller keeps the pre-editor draft
export function shouldApplyEdit(
  original: string,
  edited: string | null
): boolean
{
  if (edited === null) return false
  if (!edited.trim()) return false
  return edited !== original
}

interface EditorOutcome
{
  text: string | null
}

function runEditorOnce(filePath: string, command: string): void
{
  const result = spawnSync(
    splitEditorCommand(command)[0]!,
    buildEditorArgs(command, filePath),
    {
      stdio: 'inherit',
    }
  )
  if (result.error) throw result.error
}

// write the draft to a private temp file, open the user's editor on it, and
// read back whatever they saved; throws propagate to the caller's catch
export async function runInExternalEditor(
  draft: string,
  env: HandoffEnv = process.env
): Promise<EditorOutcome>
{
  const command = resolveEditorCommand(env)
  if (!command) return { text: null }

  const dir = mkdtempSync(join(tmpdir(), 'coral-edit-'))
  const filePath = join(dir, 'draft.md')
  try
  {
    writeFileSync(filePath, draft, 'utf-8')
    runEditorOnce(filePath, command)
    const edited = readFileSync(filePath, 'utf-8')
    return { text: shouldApplyEdit(draft, edited) ? edited : null }
  }
  finally
  {
    rmSync(dir, { recursive: true, force: true })
  }
}
