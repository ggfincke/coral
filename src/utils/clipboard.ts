// src/utils/clipboard.ts
// write text to the system clipboard via the platform's native CLI

import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { toErrorMessage } from './errors.js'

export interface ClipboardResult
{
  ok: boolean
  error?: string
}

interface ClipboardCommand
{
  file: string
  args: string[]
}

// ordered candidate commands per platform — first that exists & exits 0 wins
function clipboardCommands(): ClipboardCommand[]
{
  switch (platform())
  {
    case 'darwin':
      return [{ file: 'pbcopy', args: [] }]
    case 'win32':
      return [{ file: 'clip', args: [] }]
    // linux/bsd — try wayland, then the two common X11 utilities
    default:
      return [
        { file: 'wl-copy', args: [] },
        { file: 'xclip', args: ['-selection', 'clipboard'] },
        { file: 'xsel', args: ['--clipboard', '--input'] },
      ]
  }
}

// missing-binary errors so the caller can fall through to the next candidate
function isMissingCommand(error: string): boolean
{
  return /ENOENT/.test(error)
}

// pipe text into one clipboard command; resolves ok on a clean exit
function pipeToCommand(
  command: ClipboardCommand,
  text: string
): Promise<ClipboardResult>
{
  return new Promise((resolve) =>
  {
    const child = spawn(command.file, command.args)
    let stderr = ''

    child.on('error', (err) =>
    {
      resolve({ ok: false, error: toErrorMessage(err) })
    })
    child.stderr?.on('data', (chunk) =>
    {
      stderr += String(chunk)
    })
    child.on('close', (code) =>
    {
      if (code === 0)
      {
        resolve({ ok: true })
        return
      }
      resolve({ ok: false, error: stderr.trim() || `exited with code ${code}` })
    })

    // swallow EPIPE when the command never spawned (ENOENT already reported)
    child.stdin?.on('error', () =>
    {})
    child.stdin?.end(text)
  })
}

// copy text to the clipboard, trying each platform candidate until one works
export async function copyToClipboard(text: string): Promise<ClipboardResult>
{
  let lastError = 'no clipboard command available'

  for (const command of clipboardCommands())
  {
    const result = await pipeToCommand(command, text)
    if (result.ok) return result

    lastError = result.error ?? lastError
    // only keep trying candidates when the binary is simply absent
    if (!isMissingCommand(lastError)) return result
  }

  return { ok: false, error: lastError }
}
