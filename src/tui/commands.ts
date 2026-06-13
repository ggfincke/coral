// src/tui/commands.ts
// slash command registry, parser, & dispatcher

import chalk from 'chalk'
import { getCwd } from '../cwd.js'
import { savePrefs } from '../config/prefs.js'
import {
  getTheme,
  setTheme,
  style,
  type Role,
  type RoleColor,
} from './theme.js'
import { findTheme, THEMES } from './themes.js'
import type { Agent } from '../agent/agent.js'
import { OllamaClient } from '../ollama/client.js'
import {
  listSessions,
  loadSession,
  sessionExists,
  type SessionMeta,
} from '../session/store.js'
import type { OutputBlock, SystemBlock } from './transcript.js'
import { runGitCommand } from '../utils/git.js'
import {
  computeTokensPerSecond,
  formatDurationNs,
  formatTokenCount,
  formatTokensPerSecond,
  pluralizeMessages,
} from './metrics.js'
import { toErrorMessage } from '../utils/errors.js'

// brand header for command output — `Coral — <title>`
function coralHeader(title: string): string
{
  return `${style('primary')('Coral')} ${style('muted')(`— ${title}`)}`
}

// context passed to every command — provides access to app state & setters
export interface CommandContext
{
  agent: Agent
  activeModel: string
  host: string
  yolo: boolean
  sessionLabelId: string | null
  // push blocks into the transcript
  pushOutput: (...blocks: OutputBlock[]) => void
  // clear the transcript & reset conversation state
  clearSession: () => void
  // reopen the model picker
  reopenModelPicker: () => void
  // switch model in-place (keeps conversation history)
  switchModel: (modelName: string) => Promise<void>
  // set the permission mode at runtime
  setYolo: (yolo: boolean) => void
  // exit the application
  exitApp: () => void
  // resume a session by ID — loads agent & transcript from disk
  resumeSession: (sessionId: string) => boolean
  // force-save the current session to disk (returns session ID or null)
  saveCurrentSession: () => string | null
  // rename the current session's title & update cached meta
  renameCurrentSession: (title: string) => boolean
  // re-render the TUI after a theme switch (busts styled-line caches)
  notifyThemeChanged: () => void
}

// a single slash command
interface Command
{
  name: string
  aliases?: string[]
  description: string
  execute: (args: string, ctx: CommandContext) => void | Promise<void>
}

// result of parsing a slash command from input
interface ParsedCommand
{
  name: string
  args: string
}

type ResumeTarget =
  | { type: 'target'; session: SessionMeta }
  | { type: 'message'; content: string }

// parse a slash command from user input
// returns null if input doesn't start w/ /
function parseCommand(input: string): ParsedCommand | null
{
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null

  const withoutSlash = trimmed.slice(1)
  if (!withoutSlash) return null

  const spaceIndex = withoutSlash.indexOf(' ')
  if (spaceIndex === -1)
  {
    return { name: withoutSlash.toLowerCase(), args: '' }
  }

  return {
    name: withoutSlash.slice(0, spaceIndex).toLowerCase(),
    args: withoutSlash.slice(spaceIndex + 1).trim(),
  }
}

// find a command by name or alias
function findCommand(name: string, commands: Command[]): Command | undefined
{
  const lower = name.toLowerCase()

  return commands.find(
    (cmd) => cmd.name === lower || cmd.aliases?.some((alias) => alias === lower)
  )
}

// build a system block for command output
function systemBlock(content: string): SystemBlock
{
  return { type: 'system', content }
}

function formatResumedSession(session: SessionMeta): string
{
  return `Resumed session ${style('user')(session.id)} — ${session.title}`
}

function resolveResumeTarget(
  args: string,
  currentSessionId: string | null
): ResumeTarget
{
  const requestedId = args.trim()
  const sessions = listSessions()

  // resolve a chosen session to a target, guarding the already-current case
  const asTarget = (session: SessionMeta): ResumeTarget =>
    session.id === currentSessionId
      ? { type: 'message', content: 'Already in this session.' }
      : { type: 'target', session }

  if (!requestedId)
  {
    const latest = sessions.find((session) => session.id !== currentSessionId)
    return latest
      ? { type: 'target', session: latest }
      : { type: 'message', content: 'No other sessions to resume.' }
  }

  const exact = sessions.find((session) => session.id === requestedId)
  if (exact) return asTarget(exact)

  // fall back to disk — a session file can exist without an index entry
  // (e.g. concurrent writers clobbering index.json, or a copied-in session)
  if (sessionExists(requestedId))
  {
    const onDisk = loadSession(requestedId)
    if (onDisk?.meta) return asTarget(onDisk.meta)
  }

  const matches = sessions.filter((session) =>
    session.id.startsWith(requestedId)
  )

  if (matches.length === 1) return asTarget(matches[0]!)

  if (matches.length > 1)
  {
    const matchList = matches
      .slice(0, 5)
      .map(
        (session) =>
          `  ${style('user')(session.id)}  ${chalk.dim(session.title)}`
      )
      .join('\n')
    return {
      type: 'message',
      content: `Ambiguous session ID "${requestedId}" — multiple matches:\n${matchList}`,
    }
  }

  return {
    type: 'message',
    content:
      `Session not found: ${requestedId}\n` +
      `Use ${style('user')('/sessions')} to see available sessions.`,
  }
}

// ── /help ──────────────────────────────────────────────────────────────

const helpCommand: Command = {
  name: 'help',
  description: 'List available commands & keybindings',
  execute(_args, ctx)
  {
    const lines: string[] = [coralHeader('available commands'), '']

    for (const cmd of commands)
    {
      const aliases = cmd.aliases?.length
        ? chalk.dim(` (${cmd.aliases.map((a) => `/${a}`).join(', ')})`)
        : ''
      lines.push(
        `  ${style('user')(`/${cmd.name}`)}${aliases}  ${chalk.dim(cmd.description)}`
      )
    }

    lines.push('')
    lines.push(`${style('muted')('— keybindings')}`)
    lines.push('')
    lines.push(
      `  ${style('user')('ctrl+y')}   ${chalk.dim('Toggle permission mode (ask / yolo)')}`
    )
    lines.push(
      `  ${style('user')('ctrl+t')}   ${chalk.dim('Toggle thinking/reasoning visibility')}`
    )
    lines.push(
      `  ${style('user')('ctrl+c')}   ${chalk.dim('Interrupt generation (or exit when idle)')}`
    )
    lines.push(
      `  ${style('user')('esc')}      ${chalk.dim('Interrupt generation (or exit when idle)')}`
    )
    lines.push(
      `  ${style('user')('↑↓')}       ${chalk.dim('Navigate input history')}`
    )
    lines.push(
      `  ${style('user')('pgup/dn')}  ${chalk.dim('Page through transcript')}`
    )

    lines.push('')
    lines.push(
      chalk.dim('Type /command to run. Commands are not sent to the model.')
    )

    ctx.pushOutput(systemBlock(lines.join('\n')))
  },
}

// ── /clear ─────────────────────────────────────────────────────────────

const clearCommand: Command = {
  name: 'clear',
  aliases: ['reset'],
  description: 'Clear conversation history & transcript',
  execute(_args, ctx)
  {
    const cleared = ctx.agent.clearHistory()
    ctx.clearSession()
    ctx.pushOutput(
      systemBlock(
        `Conversation cleared (${pluralizeMessages(cleared)} removed)`
      )
    )
  },
}

// ── /compact ───────────────────────────────────────────────────────────

const compactCommand: Command = {
  name: 'compact',
  description: 'Compact conversation history to free context space',
  async execute(_args, ctx)
  {
    const msgCount = ctx.agent.getMessageCount()
    if (msgCount < 4)
    {
      ctx.pushOutput(systemBlock('Conversation too short to compact'))
      return
    }

    ctx.pushOutput(systemBlock('Compacting conversation...'))

    const result = await ctx.agent.forceCompact()

    if (!result)
    {
      ctx.pushOutput(
        systemBlock('Compaction skipped — not enough context to summarize')
      )
      return
    }

    const savedTokens = result.beforeTokens - result.afterTokens
    const savedMessages = result.beforeMessages - result.afterMessages
    const lines = [
      `Context compacted`,
      `  ${result.beforeMessages} messages -> ${result.afterMessages} messages (${savedMessages} summarized)`,
      `  ~${formatTokenCount(result.beforeTokens)} -> ~${formatTokenCount(result.afterTokens)} tokens (${formatTokenCount(savedTokens)} freed)`,
    ]

    ctx.pushOutput(systemBlock(lines.join('\n')))
  },
}

// ── /status ────────────────────────────────────────────────────────────

const statusCommand: Command = {
  name: 'status',
  description: 'Show model, session, token usage, & working directory',
  execute(_args, ctx)
  {
    const cwd = getCwd()
    const model = ctx.activeModel
    const tokens = ctx.agent.getEstimatedTokens()
    const messages = ctx.agent.getMessageCount()
    const session = ctx.sessionLabelId ?? '(unsaved)'
    const permissions = ctx.yolo
      ? 'yolo (auto-approve all)'
      : 'ask (prompt before writes)'
    const gitBranch = getGitBranch(cwd)
    const usage = ctx.agent.getTokenUsage()

    const lines: string[] = [
      coralHeader('status'),
      '',
      `  Model:        ${chalk.white(model)}`,
      `  Permissions:  ${ctx.yolo ? style('warning')(permissions) : chalk.dim(permissions)}`,
      `  Session:      ${chalk.dim(session)}`,
      `  Messages:     ${chalk.dim(String(messages))}`,
      `  Tokens (est): ${chalk.dim(`~${formatTokenCount(tokens)}`)}`,
    ]

    // tokens actually seen by Ollama this session (authoritative, not estimated)
    if (usage.promptTokens > 0 || usage.completionTokens > 0)
    {
      lines.push(
        `  Prompt toks:  ${chalk.dim(formatTokenCount(usage.promptTokens))}`,
        `  Decode toks:  ${chalk.dim(formatTokenCount(usage.completionTokens))}`
      )
    }

    // cumulative throughput — averaged over all turns in the session
    const avgPrefillTps = computeTokensPerSecond(
      usage.promptTokens,
      usage.promptEvalDurationNs
    )
    const avgDecodeTps = computeTokensPerSecond(
      usage.completionTokens,
      usage.evalDurationNs
    )
    const prefillStr = formatTokensPerSecond(avgPrefillTps)
    const decodeStr = formatTokensPerSecond(avgDecodeTps)

    if (decodeStr)
    {
      lines.push(`  Decode speed: ${chalk.dim(`${decodeStr} (avg)`)}`)
    }
    if (prefillStr)
    {
      lines.push(`  Prefill speed:${chalk.dim(` ${prefillStr} (avg)`)}`)
    }

    // cumulative time Ollama spent generating this session
    const totalModelNs = usage.promptEvalDurationNs + usage.evalDurationNs
    if (totalModelNs > 0)
    {
      lines.push(`  Model time:   ${chalk.dim(formatDurationNs(totalModelNs))}`)
    }

    const compactions = ctx.agent.getCompactionCount()
    if (compactions > 0)
    {
      lines.push(`  Compactions:  ${chalk.dim(String(compactions))}`)
    }

    // reliability-layer counters — only shown once something needed repair
    const reliability = ctx.agent.getReliabilityStats()
    const repairs = reliability.repairedToolCalls + reliability.nameRepairs
    if (
      repairs + reliability.stallNudges + reliability.validationFailures >
      0
    )
    {
      lines.push(
        `  Repairs:      ${chalk.dim(
          `${repairs} tool-call, ${reliability.stallNudges} nudge, ${reliability.validationFailures} invalid-args`
        )}`
      )
    }

    lines.push(`  CWD:          ${chalk.dim(cwd)}`)

    if (gitBranch)
    {
      lines.push(`  Git branch:   ${chalk.dim(gitBranch)}`)
    }

    ctx.pushOutput(systemBlock(lines.join('\n')))
  },
}

// get the current git branch, or null if not in a repo
function getGitBranch(cwd: string): string | null
{
  const result = runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, {
    timeout: 3000,
  })

  return result.error || !result.output ? null : result.output
}

// ── /exit ──────────────────────────────────────────────────────────────

const exitCommand: Command = {
  name: 'exit',
  aliases: ['quit'],
  description: 'Exit Coral',
  execute(_args, ctx)
  {
    ctx.exitApp()
  },
}

// ── /model ─────────────────────────────────────────────────────────────

const modelCommand: Command = {
  name: 'model',
  description: 'Switch to a different model (or open picker w/ no args)',
  async execute(args, ctx)
  {
    // no args — open the interactive model picker
    if (!args)
    {
      ctx.reopenModelPicker()
      return
    }

    const requestedModel = args.trim()

    // validate model exists in Ollama
    ctx.pushOutput(systemBlock(`Looking up model: ${requestedModel}...`))

    let availableModels: string[]
    try
    {
      const client = new OllamaClient(ctx.host)
      const models = await client.listModels()
      availableModels = models.map((m) => m.name)
    }
    catch
    {
      ctx.pushOutput(
        systemBlock('Failed to fetch models from Ollama — is it running?')
      )
      return
    }

    // try exact match first, then prefix match
    const exactMatch = availableModels.find((name) => name === requestedModel)
    const prefixMatches = exactMatch
      ? []
      : availableModels.filter((name) => name.startsWith(requestedModel))

    const resolvedModel =
      exactMatch ?? (prefixMatches.length === 1 ? prefixMatches[0]! : null)

    if (!resolvedModel)
    {
      if (prefixMatches.length > 1)
      {
        const matchList = prefixMatches
          .slice(0, 10)
          .map((n) => `  ${n}`)
          .join('\n')
        ctx.pushOutput(
          systemBlock(
            `Ambiguous model name "${requestedModel}" — multiple matches:\n${matchList}\n\nBe more specific or use /model to open the picker.`
          )
        )
      }
      else
      {
        ctx.pushOutput(
          systemBlock(
            `Model "${requestedModel}" not found in Ollama.\n` +
              `Use ${style('user')('/model')} to open the picker, or pull it first.`
          )
        )
      }
      return
    }

    // skip if already using this model
    if (resolvedModel === ctx.activeModel)
    {
      ctx.pushOutput(systemBlock(`Already using ${resolvedModel}`))
      return
    }

    // switch in-place — preserves conversation history
    const previousModel = ctx.activeModel
    try
    {
      await ctx.switchModel(resolvedModel)
      ctx.pushOutput(
        systemBlock(`Switched model: ${previousModel} → ${resolvedModel}`)
      )
    }
    catch (err)
    {
      const msg = toErrorMessage(err)
      ctx.pushOutput(systemBlock(`Failed to switch model: ${msg}`))
    }
  },
}

// ── /permissions ──────────────────────────────────────────────────────

const permissionsCommand: Command = {
  name: 'permissions',
  aliases: ['perm', 'perms'],
  description: 'Show or set permission mode (ask / yolo)',
  execute(args, ctx)
  {
    if (!args)
    {
      const current = ctx.yolo ? 'yolo' : 'ask'
      const description = ctx.yolo
        ? 'auto-approve all tool calls'
        : 'prompt before writes & shell commands'
      ctx.pushOutput(
        systemBlock(
          `Permission mode: ${chalk.bold(current)} (${description})\n\n` +
            `  ${style('user')('/permissions ask')}   — prompt before writes & shell commands\n` +
            `  ${style('user')('/permissions yolo')}  — auto-approve all tool calls\n` +
            `  ${chalk.dim('ctrl+y')}             — quick toggle`
        )
      )
      return
    }

    const mode = args.trim().toLowerCase()

    if (mode === 'yolo')
    {
      ctx.setYolo(true)
      ctx.pushOutput(
        systemBlock(
          `Permission mode → ${style('warning').bold('yolo')} (all tool calls auto-approved)`
        )
      )
    }
    else if (mode === 'ask')
    {
      ctx.setYolo(false)
      ctx.pushOutput(
        systemBlock(
          `Permission mode → ${chalk.bold('ask')} (prompt before writes & shell commands)`
        )
      )
    }
    else
    {
      ctx.pushOutput(
        systemBlock(
          `Unknown permission mode: "${mode}"\n` +
            `Valid modes: ${style('user')('ask')}, ${style('user')('yolo')}`
        )
      )
    }
  },
}

// ── /theme ─────────────────────────────────────────────────────────────

// colored swatch dot rendered in a specific theme's own palette
function swatch(color: RoleColor): string
{
  return 'ansi' in color
    ? chalk[color.ansi]('●')
    : chalk.rgb(color.r, color.g, color.b)('●')
}

const SWATCH_ROLES: Role[] = ['primary', 'accent', 'user', 'code', 'muted']

function formatThemeList(): string
{
  const current = getTheme()
  const maxName = Math.max(...THEMES.map((theme) => theme.name.length))
  const lines: string[] = [coralHeader('themes'), '']

  for (const theme of THEMES)
  {
    const dots = SWATCH_ROLES.map((role) => swatch(theme.roles[role])).join(' ')
    const marker = theme === current ? style('primary')('›') : ' '
    lines.push(
      `${marker} ${dots}  ${theme.name.padEnd(maxName)}  ${chalk.dim(theme.description)}`
    )
  }

  lines.push('')
  lines.push(chalk.dim(`Switch with ${style('user')('/theme <name>')}`))
  return lines.join('\n')
}

const themeCommand: Command = {
  name: 'theme',
  description: 'Show or switch the color theme',
  execute(args, ctx)
  {
    if (!args)
    {
      ctx.pushOutput(systemBlock(formatThemeList()))
      return
    }

    const theme = findTheme(args)

    if (!theme)
    {
      ctx.pushOutput(
        systemBlock(`Unknown theme: "${args.trim()}"\n\n${formatThemeList()}`)
      )
      return
    }

    if (theme === getTheme())
    {
      ctx.pushOutput(systemBlock(`Already using ${theme.label}`))
      return
    }

    setTheme(theme)
    savePrefs({ theme: theme.name })
    ctx.notifyThemeChanged()
    ctx.pushOutput(systemBlock(`Theme → ${theme.label} (saved to prefs)`))
  },
}

// ── /diff ──────────────────────────────────────────────────────────────

const diffCommand: Command = {
  name: 'diff',
  description: 'Show git diff of working directory',
  execute(_args, ctx)
  {
    const cwd = getCwd()

    const result = runGitCommand(['diff'], cwd, { allowStdoutOnError: true })

    if (result.error)
    {
      ctx.pushOutput(
        systemBlock('Not a git repository, or git is not installed')
      )
      return
    }

    if (!result.output.trim())
    {
      ctx.pushOutput(systemBlock('No uncommitted changes'))
      return
    }

    // diff blocks render w/ gutter & theme colors in the transcript
    ctx.pushOutput({ type: 'diff', unified: result.output })
  },
}

// ── /sessions ─────────────────────────────────────────────────────────

const sessionsCommand: Command = {
  name: 'sessions',
  aliases: ['ls'],
  description: 'List recent saved sessions',
  execute(args, ctx)
  {
    const count = args ? parseInt(args, 10) : 10
    const limit = Number.isFinite(count) && count > 0 ? count : 10
    const sessions = listSessions().slice(0, limit)

    if (sessions.length === 0)
    {
      ctx.pushOutput(systemBlock('No saved sessions.'))
      return
    }

    const lines: string[] = [coralHeader('saved sessions'), '']

    for (const s of sessions)
    {
      const date = new Date(s.updatedAt).toLocaleString()
      const isCurrent = s.id === ctx.sessionLabelId
      const marker = isCurrent ? style('success')(' ●') : '  '
      lines.push(
        `${marker} ${style('user')(s.id)}  ${chalk.white(s.model)}  ${chalk.dim(date)}  ${chalk.dim(`(${s.messageCount} msgs)`)}`
      )
      lines.push(`     ${chalk.dim(s.title)}`)
    }

    lines.push('')
    lines.push(chalk.dim(`Resume with ${style('user')('/resume <id>')}`))

    ctx.pushOutput(systemBlock(lines.join('\n')))
  },
}

// ── /resume ───────────────────────────────────────────────────────────

const resumeCommand: Command = {
  name: 'resume',
  description: 'Resume a saved session (no args = latest)',
  execute(args, ctx)
  {
    const target = resolveResumeTarget(args, ctx.sessionLabelId)

    if (target.type === 'message')
    {
      ctx.pushOutput(systemBlock(target.content))
      return
    }

    ctx.saveCurrentSession()

    if (ctx.resumeSession(target.session.id))
    {
      ctx.pushOutput(systemBlock(formatResumedSession(target.session)))
      return
    }

    ctx.pushOutput(systemBlock(`Failed to load session: ${target.session.id}`))
  },
}

// ── /rename ───────────────────────────────────────────────────────────

const renameCommand: Command = {
  name: 'rename',
  description: 'Rename the current session',
  execute(args, ctx)
  {
    if (!ctx.sessionLabelId)
    {
      ctx.pushOutput(
        systemBlock('No active session to rename. Send a message first.')
      )
      return
    }

    if (!args.trim())
    {
      const sessions = listSessions()
      const current = sessions.find((s) => s.id === ctx.sessionLabelId)
      const title = current?.title ?? '(unknown)'
      ctx.pushOutput(
        systemBlock(
          `Current session: ${style('user')(ctx.sessionLabelId)}\n` +
            `Title: ${title}\n\n` +
            `Usage: ${style('user')('/rename <new title>')}`
        )
      )
      return
    }

    const ok = ctx.renameCurrentSession(args.trim())

    if (ok)
    {
      ctx.pushOutput(systemBlock(`Session renamed to: ${args.trim()}`))
    }
    else
    {
      ctx.pushOutput(systemBlock('Failed to rename session.'))
    }
  },
}

// ── /new ──────────────────────────────────────────────────────────────

const newCommand: Command = {
  name: 'new',
  description: 'Save current session & start a new conversation',
  execute(_args, ctx)
  {
    const savedId = ctx.saveCurrentSession()
    const cleared = ctx.agent.clearHistory()
    ctx.clearSession()

    const parts: string[] = []
    if (savedId)
    {
      parts.push(`Session ${savedId} saved`)
    }
    parts.push(
      `New conversation started (${pluralizeMessages(cleared)} cleared)`
    )

    ctx.pushOutput(systemBlock(parts.join(' · ')))
  },
}

// ── registry ───────────────────────────────────────────────────────────

// all registered commands — order determines /help display order
const commands: Command[] = [
  helpCommand,
  clearCommand,
  compactCommand,
  statusCommand,
  modelCommand,
  permissionsCommand,
  themeCommand,
  diffCommand,
  sessionsCommand,
  resumeCommand,
  renameCommand,
  newCommand,
  exitCommand,
]

// dispatch a slash command from user input
// returns true if input was a command, false otherwise
export async function dispatchCommand(
  input: string,
  ctx: CommandContext
): Promise<boolean>
{
  const parsed = parseCommand(input)
  if (!parsed) return false

  const cmd = findCommand(parsed.name, commands)
  if (!cmd)
  {
    ctx.pushOutput(
      systemBlock(
        `Unknown command: /${parsed.name}\n` +
          `Type ${style('user')('/help')} to see available commands.`
      )
    )
    return true
  }

  await cmd.execute(parsed.args, ctx)
  return true
}
