// src/utils/clipboard.ts
// write text to the system clipboard w/ OSC 52 reach across ssh & tmux

import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { toErrorMessage } from './errors.js'

export interface ClipboardResult
{
  ok: boolean
  error?: string
  // transport that accepted the payload, for diagnosable copy feedback
  via?: string
}

interface ClipboardCommand
{
  file: string
  args: string[]
}

// ordered candidate commands per platform; use the first available command
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

export interface ClipboardEnv
{
  TMUX?: string
  SSH_CONNECTION?: string
  LC_TERMINAL?: string
}

export function encodeOsc52(text: string): string
{
  return `\u001b]52;c;${Buffer.from(text, 'utf-8').toString('base64')}\u0007`
}

const ESC = '\u001b'

// tmux consumes raw escapes, so passthrough wraps them in a DCS frame w/ every
// inner ESC doubled
export function wrapOsc52ForTmux(sequence: string): string
{
  return `${ESC}Ptmux;${sequence.split(ESC).join(ESC + ESC)}${ESC}\\`
}

export function inTmux(env: ClipboardEnv): boolean
{
  return Boolean(env.TMUX)
}

export function overSsh(env: ClipboardEnv): boolean
{
  return Boolean(env.SSH_CONNECTION)
}

// iTerm2 crashes on `tmux load-buffer -w`, so the system-copy flag is dropped
export function isItermTerminal(env: ClipboardEnv): boolean
{
  return env.LC_TERMINAL === 'iTerm2'
}

export function tmuxLoadBufferArgs(env: ClipboardEnv): string[]
{
  return isItermTerminal(env)
    ? ['load-buffer', '-']
    : ['load-buffer', '-w', '-']
}

// write an escape sequence straight to the terminal; optimistic-ok since most
// terminals silently ignore unsupported sequences
function writeToStdout(sequence: string): Promise<ClipboardResult>
{
  return new Promise((resolve) =>
  {
    const out = process.stdout
    if (!out.writable)
    {
      resolve({ ok: false, error: 'stdout not writable' })
      return
    }
    out.write(sequence, (error) =>
    {
      if (error)
      {
        resolve({ ok: false, error: toErrorMessage(error) })
        return
      }
      resolve({ ok: true })
    })
  })
}

type EnvReader = () => ClipboardEnv

async function copyToClipboardWithEnv(
  text: string,
  readEnv: EnvReader
): Promise<ClipboardResult>
{
  const env = readEnv()
  const ssh = overSsh(env)

  // inside tmux, load-buffer feeds the server buffer (& system via -w); it is
  // the only native path that works without terminal clipboard integration
  if (inTmux(env))
  {
    const result = await pipeToCommand(
      { file: 'tmux', args: tmuxLoadBufferArgs(env) },
      text
    )
    if (result.ok) return { ...result, via: 'tmux load-buffer' }
  }

  // local runs trust native binaries first; remote runs skip straight to
  // escape-sequence transports because the binaries would target the wrong host
  let lastError = ssh
    ? 'clipboard binaries unavailable over ssh'
    : 'no clipboard command available'
  if (!ssh)
  {
    for (const command of clipboardCommands())
    {
      const result = await pipeToCommand(command, text)
      if (result.ok) return { ...result, via: command.file }
      lastError = result.error ?? lastError
      // only keep trying candidates when the binary is simply absent
      if (!isMissingCommand(lastError)) break
    }
  }

  // escape-sequence fallback: bare OSC 52 normally; DCS-wrapped so tmux
  // forwards it to the outer terminal intact
  const wrapped = inTmux(env)
  const sequence = wrapped
    ? wrapOsc52ForTmux(encodeOsc52(text))
    : encodeOsc52(text)
  const result = await writeToStdout(sequence)
  if (result.ok)
  {
    return {
      ok: true,
      via: wrapped ? 'OSC 52 (tmux passthrough)' : 'OSC 52',
    }
  }

  return { ok: false, error: lastError }
}

// copy text to the clipboard trying transports in reliability order:
// tmux buffer -> local natives -> OSC 52 (bare or tmux-wrapped)
export async function copyToClipboard(text: string): Promise<ClipboardResult>
{
  return copyToClipboardWithEnv(text, () => process.env as ClipboardEnv)
}
