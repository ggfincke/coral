// src/cli/interactive.tsx
// parse interactive CLI args and render the TUI

import { render } from 'ink'
import { resolve } from 'node:path'
import { isSessionDirectory, sameWorkspace } from '../session/resume.js'
import { parseCliArgs, type CliOptions } from './args.js'
import App from '../tui/App.js'
import { loadPrefs } from '../config/prefs.js'
import { listSessions } from '../session/store.js'
import { resolveResumeSession } from '../session/resume.js'
import { setTheme } from '../tui/theme.js'
import { findTheme, THEMES } from '../tui/themes.js'
import {
  kittyKeyboardOptIn,
  noColorRequested,
} from '../tui/shell/terminal-prefs.js'
import {
  formatCliResumeError,
  formatCliSessionList,
} from '../tui/commands/session-output.js'
import { launchCliApp } from './app-launch.js'

export async function runInteractiveCli(
  input: CliOptions | string[] = process.argv
): Promise<void>
{
  const parsed = Array.isArray(input)
    ? parseCliArgs(input.slice(2))
    : { kind: 'interactive' as const, options: input }
  if (parsed.kind === 'exit')
  {
    process.exitCode = parsed.code
    return
  }
  const opts = parsed.options
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd()
  if (!isSessionDirectory(cwd))
  {
    console.error(`Not a workspace directory: ${cwd}`)
    process.exitCode = 1
    return
  }
  // resolve theme: --theme flag > saved prefs > default
  if (opts.theme)
  {
    const theme = findTheme(opts.theme)
    if (!theme)
    {
      console.error(`Unknown theme: ${opts.theme}`)
      console.error(`Available themes: ${THEMES.map((t) => t.name).join(', ')}`)
      process.exit(1)
    }
    setTheme(theme)
  }
  else
  {
    const saved = loadPrefs().theme
    if (saved)
    {
      const theme = findTheme(saved)
      if (theme) setTheme(theme)
      else console.error(`Ignoring unknown theme in prefs.json: ${saved}`)
    }
    // honor NO_COLOR / FORCE_COLOR=0 by forcing the ANSI-adaptive palette
    if (noColorRequested())
    {
      const adaptive = findTheme('adaptive')
      if (adaptive) setTheme(adaptive)
    }
  }

  // handle --sessions by listing sessions and exiting
  if (opts.sessions)
  {
    console.log(
      formatCliSessionList(
        (await listSessions()).filter(
          (session) => !opts.cwd || sameWorkspace(session.cwd, cwd)
        )
      )
    )
    process.exit(0)
  }

  // resolve session to resume (if any)
  let resumeSessionId: string | undefined

  if (opts.session)
  {
    const resolution = await resolveResumeSession({
      requestedId: opts.session,
      allowPrefix: true,
      requireExistingCwd: true,
    })

    if (resolution.type !== 'target')
    {
      console.error(formatCliResumeError(resolution))
      process.exit(1)
    }

    if (opts.cwd && !sameWorkspace(cwd, resolution.session.cwd))
    {
      console.error(
        `Session workspace ${resolution.session.cwd} conflicts with --cwd ${cwd}.`
      )
      process.exitCode = 1
      return
    }
    resumeSessionId = resolution.session.id
  }
  else if (opts.resume)
  {
    const resolution = await resolveResumeSession({
      requireExistingCwd: true,
      cwd: opts.cwd ? cwd : undefined,
    })

    if (resolution.type !== 'target')
    {
      console.error(formatCliResumeError(resolution))
      process.exit(1)
    }

    resumeSessionId = resolution.session.id
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY)
  {
    console.error(
      'Interactive Coral requires terminal stdin and stdout. Use coral exec -m <model> "prompt" or --prompt-file - for pipelines.'
    )
    process.exitCode = 1
    return
  }
  const exitCode = launchCliApp(
    {
      model: opts.model,
      cwd,
      initialPrompt: opts.prompt,
      host: opts.host,
      think: opts.think ?? true,
      yolo: opts.yolo ?? false,
      resumeSessionId,
    },
    (props) =>
    {
      render(<App {...props} />, {
        exitOnCtrlC: false,
        // kitty keyboard protocol is opt-in; the tokenizer learns CSI-u
        // shapes independently (src/tui/input/keypress.ts)
        kittyKeyboard: kittyKeyboardOptIn() ? { mode: 'enabled' } : undefined,
      })
    },
    (message) => console.error(message)
  )

  if (exitCode !== 0) process.exitCode = exitCode
}
