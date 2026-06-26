#!/usr/bin/env node
// src/cli/main.tsx
// CLI entry point — parse args & render TUI

import { render } from 'ink'
import { Command } from 'commander'
import { createRequire } from 'node:module'
import App from '../tui/App.js'
import { loadPrefs } from '../config/prefs.js'
import { listSessions } from '../session/store.js'
import { resolveResumeSession } from '../session/resume.js'
import { setTheme } from '../tui/theme.js'
import { findTheme, THEMES } from '../tui/themes.js'
import { DEFAULT_OLLAMA_HOST } from '../ollama/host.js'
import {
  formatCliResumeError,
  formatCliSessionList,
} from '../tui/shell/command-output.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

const program = new Command()
  .name('coral')
  .description('A CLI/TUI coding agent for Ollama')
  .version(version)
  .option('-m, --model <model>', 'Ollama model to use')
  .option('--host <url>', 'Ollama host URL', DEFAULT_OLLAMA_HOST)
  .option('--no-think', 'disable streamed reasoning requests')
  .option('--yolo', 'skip all tool approval prompts (auto-accept everything)')
  .option('--resume', 'resume the most recent session')
  .option('--session <id>', 'resume a specific session by ID')
  .option('--sessions', 'list saved sessions & exit')
  .option('--theme <name>', 'color theme (see /theme for the list)')
  .parse(process.argv)

const opts = program.opts<{
  model?: string
  host: string
  think: boolean
  yolo: boolean
  resume: boolean
  session?: string
  sessions: boolean
  theme?: string
}>()

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
}

// handle --sessions: list & exit
if (opts.sessions)
{
  console.log(formatCliSessionList(listSessions()))
  process.exit(0)
}

// resolve session to resume (if any)
let resumeSessionId: string | undefined

if (opts.session)
{
  const resolution = resolveResumeSession({
    requestedId: opts.session,
    allowPrefix: false,
    requireExistingCwd: true,
  })

  if (resolution.type !== 'target')
  {
    console.error(formatCliResumeError(resolution))
    process.exit(1)
  }

  resumeSessionId = resolution.session.id
}
else if (opts.resume)
{
  const resolution = resolveResumeSession({ requireExistingCwd: true })

  if (resolution.type !== 'target')
  {
    console.error(formatCliResumeError(resolution))
    process.exit(1)
  }

  resumeSessionId = resolution.session.id
}

render(
  <App
    model={opts.model}
    host={opts.host}
    think={opts.think ?? true}
    yolo={opts.yolo ?? false}
    resumeSessionId={resumeSessionId}
  />,
  { exitOnCtrlC: false }
)
