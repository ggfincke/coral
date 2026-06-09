// src/tui/commands.ts
// slash command registry, parser, & dispatcher

import chalk from 'chalk'
import { execSync } from 'node:child_process'
import { getCwd } from '../cwd.js'
import { coral, ocean, sand } from './theme.js'
import type { Agent } from '../agent/agent.js'
import { OllamaClient } from '../ollama/client.js'
import { listSessions, sessionExists } from '../session/store.js'
import type { OutputBlock, SystemBlock } from './transcript.js'

// context passed to every command — provides access to app state & setters
export interface CommandContext
{
  agent: Agent
  activeModel: string
  host: string
  yolo: boolean
  sessionLabelId: string | null
  messageCount: number
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
}

// a single slash command
export interface Command
{
  name: string
  aliases?: string[]
  description: string
  execute: (args: string, ctx: CommandContext) => void | Promise<void>
}

// result of parsing a slash command from input
export interface ParsedCommand
{
  name: string
  args: string
}

// result of dispatching a command
export interface DispatchResult
{
  // true if input was recognized as a command (even if it failed)
  handled: boolean
}

// parse a slash command from user input
// returns null if input doesn't start w/ /
export function parseCommand(input: string): ParsedCommand | null
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
export function findCommand(
  name: string,
  commands: Command[]
): Command | undefined
{
  const lower = name.toLowerCase()

  return commands.find(
    (cmd) =>
      cmd.name === lower ||
      cmd.aliases?.some((alias) => alias === lower)
  )
}

// build a system block for command output
function systemBlock(content: string): SystemBlock
{
  return { type: 'system', content }
}

// ── /help ──────────────────────────────────────────────────────────────

const helpCommand: Command = {
  name: 'help',
  description: 'List available commands & keybindings',
  execute(_args, ctx)
  {
    const lines: string[] = [
      `${coral('Coral')} ${sand('— available commands')}`,
      '',
    ]

    for (const cmd of commands)
    {
      const aliases = cmd.aliases?.length
        ? chalk.dim(` (${cmd.aliases.map((a) => `/${a}`).join(', ')})`)
        : ''
      lines.push(`  ${ocean(`/${cmd.name}`)}${aliases}  ${chalk.dim(cmd.description)}`)
    }

    lines.push('')
    lines.push(`${sand('— keybindings')}`)
    lines.push('')
    lines.push(`  ${ocean('ctrl+y')}   ${chalk.dim('Toggle permission mode (ask / yolo)')}`)
    lines.push(`  ${ocean('ctrl+t')}   ${chalk.dim('Toggle thinking/reasoning visibility')}`)
    lines.push(`  ${ocean('ctrl+c')}   ${chalk.dim('Interrupt generation (or exit when idle)')}`)
    lines.push(`  ${ocean('esc')}      ${chalk.dim('Interrupt generation (or exit when idle)')}`)
    lines.push(`  ${ocean('↑↓')}       ${chalk.dim('Navigate input history')}`)
    lines.push(`  ${ocean('pgup/dn')}  ${chalk.dim('Page through transcript')}`)

    lines.push('')
    lines.push(chalk.dim('Type /command to run. Commands are not sent to the model.'))

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
        `Conversation cleared (${cleared} ${cleared === 1 ? 'message' : 'messages'} removed)`
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
      ctx.pushOutput(
        systemBlock('Conversation too short to compact')
      )
      return
    }

    ctx.pushOutput(systemBlock('Compacting conversation...'))

    const result = await ctx.agent.forceCompact()

    if (!result)
    {
      ctx.pushOutput(systemBlock('Compaction skipped — not enough context to summarize'))
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

// format a token count for display (e.g., 1234 -> "1.2k", 567 -> "567")
function formatTokenCount(tokens: number): string
{
  if (tokens >= 1000)
  {
    return `${(tokens / 1000).toFixed(1)}k`
  }
  return String(tokens)
}

// ── /status ────────────────────────────────────────────────────────────

// format a ns duration as "4.2s", "1m 23s", etc.
function formatDurationNs(ns: number): string
{
  const ms = ns / 1e6
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remSeconds = Math.round(seconds - minutes * 60)
  return `${minutes}m ${String(remSeconds).padStart(2, '0')}s`
}

// compute tokens/sec from nanosecond duration — 0 when inputs are invalid
function tokensPerSecond(tokens: number, durationNs: number): number
{
  if (!tokens || !durationNs || durationNs <= 0) return 0
  return tokens / (durationNs / 1e9)
}

// format a tok/s number compactly, "" when zero
function formatThroughput(tps: number): string
{
  if (tps <= 0) return ''
  if (tps >= 100) return `${Math.round(tps)} tok/s`
  return `${tps.toFixed(1)} tok/s`
}

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
    const permissions = ctx.yolo ? 'yolo (auto-approve all)' : 'ask (prompt before writes)'
    const gitBranch = getGitBranch(cwd)
    const usage = ctx.agent.getTokenUsage()

    const lines: string[] = [
      `${coral('Coral')} ${sand('— status')}`,
      '',
      `  Model:        ${chalk.white(model)}`,
      `  Permissions:  ${ctx.yolo ? chalk.yellow(permissions) : chalk.dim(permissions)}`,
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
    const avgPrefillTps = tokensPerSecond(
      usage.promptTokens,
      usage.promptEvalDurationNs
    )
    const avgDecodeTps = tokensPerSecond(
      usage.completionTokens,
      usage.evalDurationNs
    )
    const prefillStr = formatThroughput(avgPrefillTps)
    const decodeStr = formatThroughput(avgDecodeTps)

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
      lines.push(
        `  Model time:   ${chalk.dim(formatDurationNs(totalModelNs))}`
      )
    }

    const compactions = ctx.agent.getCompactionCount()
    if (compactions > 0)
    {
      lines.push(`  Compactions:  ${chalk.dim(String(compactions))}`)
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
  try
  {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    }).trim()
  }
  catch
  {
    return null
  }
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
    const exactMatch = availableModels.find(
      (name) => name === requestedModel
    )
    const prefixMatches = exactMatch
      ? []
      : availableModels.filter((name) => name.startsWith(requestedModel))

    const resolvedModel = exactMatch ?? (prefixMatches.length === 1 ? prefixMatches[0]! : null)

    if (!resolvedModel)
    {
      if (prefixMatches.length > 1)
      {
        const matchList = prefixMatches.slice(0, 10).map((n) => `  ${n}`).join('\n')
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
            `Use ${ocean('/model')} to open the picker, or pull it first.`
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
      const msg = err instanceof Error ? err.message : String(err)
      ctx.pushOutput(
        systemBlock(`Failed to switch model: ${msg}`)
      )
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
          `  ${ocean('/permissions ask')}   — prompt before writes & shell commands\n` +
          `  ${ocean('/permissions yolo')}  — auto-approve all tool calls\n` +
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
        systemBlock(`Permission mode → ${chalk.yellow.bold('yolo')} (all tool calls auto-approved)`)
      )
    }
    else if (mode === 'ask')
    {
      ctx.setYolo(false)
      ctx.pushOutput(
        systemBlock(`Permission mode → ${chalk.bold('ask')} (prompt before writes & shell commands)`)
      )
    }
    else
    {
      ctx.pushOutput(
        systemBlock(
          `Unknown permission mode: "${mode}"\n` +
          `Valid modes: ${ocean('ask')}, ${ocean('yolo')}`
        )
      )
    }
  },
}

// ── /diff ──────────────────────────────────────────────────────────────

const diffCommand: Command = {
  name: 'diff',
  description: 'Show git diff of working directory',
  execute(_args, ctx)
  {
    const cwd = getCwd()

    let diffOutput: string
    try
    {
      diffOutput = execSync('git diff', {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      })
    }
    catch (err: unknown)
    {
      // git diff returns exit code 1 when there are changes in some configs,
      // but the output is still valid — check if we got stdout
      const execErr = err as { stdout?: string; status?: number }
      if (execErr.stdout)
      {
        diffOutput = execErr.stdout
      }
      else
      {
        ctx.pushOutput(
          systemBlock('Not a git repository, or git is not installed')
        )
        return
      }
    }

    if (!diffOutput.trim())
    {
      ctx.pushOutput(systemBlock('No uncommitted changes'))
      return
    }

    // colorize the raw diff output
    const colorized = colorizeDiff(diffOutput)
    ctx.pushOutput(systemBlock(colorized))
  },
}

// apply basic git-diff coloring to raw diff output
function colorizeDiff(raw: string): string
{
  return raw
    .split('\n')
    .map((line) =>
    {
      if (line.startsWith('+++') || line.startsWith('---'))
      {
        return chalk.bold(line)
      }
      if (line.startsWith('+'))
      {
        return chalk.green(line)
      }
      if (line.startsWith('-'))
      {
        return chalk.red(line)
      }
      if (line.startsWith('@@'))
      {
        return chalk.cyan(line)
      }
      if (line.startsWith('diff '))
      {
        return chalk.bold.white(line)
      }
      return chalk.dim(line)
    })
    .join('\n')
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

    const lines: string[] = [
      `${coral('Coral')} ${sand('— saved sessions')}`,
      '',
    ]

    for (const s of sessions)
    {
      const date = new Date(s.updatedAt).toLocaleString()
      const isCurrent = s.id === ctx.sessionLabelId
      const marker = isCurrent ? chalk.green(' ●') : '  '
      lines.push(
        `${marker} ${ocean(s.id)}  ${chalk.white(s.model)}  ${chalk.dim(date)}  ${chalk.dim(`(${s.messageCount} msgs)`)}`
      )
      lines.push(`     ${chalk.dim(s.title)}`)
    }

    lines.push('')
    lines.push(chalk.dim(`Resume with ${ocean('/resume <id>')}`))

    ctx.pushOutput(systemBlock(lines.join('\n')))
  },
}

// ── /resume ───────────────────────────────────────────────────────────

const resumeCommand: Command = {
  name: 'resume',
  description: 'Resume a saved session (no args = latest)',
  execute(args, ctx)
  {
    if (!args)
    {
      // resume the most recent session that isn't the current one
      const sessions = listSessions()
      const target = sessions.find((s) => s.id !== ctx.sessionLabelId)

      if (!target)
      {
        ctx.pushOutput(systemBlock('No other sessions to resume.'))
        return
      }

      ctx.saveCurrentSession()
      const ok = ctx.resumeSession(target.id)

      if (ok)
      {
        ctx.pushOutput(
          systemBlock(`Resumed session ${ocean(target.id)} — ${target.title}`)
        )
      }
      else
      {
        ctx.pushOutput(systemBlock('Failed to load session.'))
      }

      return
    }

    const requestedId = args.trim()

    // same session guard
    if (requestedId === ctx.sessionLabelId)
    {
      ctx.pushOutput(systemBlock('Already in this session.'))
      return
    }

    // exact match
    if (sessionExists(requestedId))
    {
      ctx.saveCurrentSession()
      const ok = ctx.resumeSession(requestedId)

      if (ok)
      {
        const sessions = listSessions()
        const meta = sessions.find((s) => s.id === requestedId)
        const title = meta?.title ?? ''
        ctx.pushOutput(
          systemBlock(`Resumed session ${ocean(requestedId)}${title ? ` — ${title}` : ''}`)
        )
      }
      else
      {
        ctx.pushOutput(systemBlock(`Failed to load session: ${requestedId}`))
      }

      return
    }

    // prefix match
    const sessions = listSessions()
    const matches = sessions.filter((s) => s.id.startsWith(requestedId))

    if (matches.length === 1)
    {
      const match = matches[0]!

      if (match.id === ctx.sessionLabelId)
      {
        ctx.pushOutput(systemBlock('Already in this session.'))
        return
      }

      ctx.saveCurrentSession()
      const ok = ctx.resumeSession(match.id)

      if (ok)
      {
        ctx.pushOutput(
          systemBlock(`Resumed session ${ocean(match.id)} — ${match.title}`)
        )
      }
      else
      {
        ctx.pushOutput(systemBlock(`Failed to load session: ${match.id}`))
      }

      return
    }

    if (matches.length > 1)
    {
      const matchList = matches
        .slice(0, 5)
        .map((s) => `  ${ocean(s.id)}  ${chalk.dim(s.title)}`)
        .join('\n')
      ctx.pushOutput(
        systemBlock(
          `Ambiguous session ID "${requestedId}" — multiple matches:\n${matchList}`
        )
      )
      return
    }

    ctx.pushOutput(
      systemBlock(
        `Session not found: ${requestedId}\n` +
        `Use ${ocean('/sessions')} to see available sessions.`
      )
    )
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
          `Current session: ${ocean(ctx.sessionLabelId)}\n` +
          `Title: ${title}\n\n` +
          `Usage: ${ocean('/rename <new title>')}`
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
      `New conversation started (${cleared} ${cleared === 1 ? 'message' : 'messages'} cleared)`
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
  diffCommand,
  sessionsCommand,
  resumeCommand,
  renameCommand,
  newCommand,
  exitCommand,
]

// get the full list of registered commands
export function getCommands(): Command[]
{
  return commands
}

// dispatch a slash command from user input
// returns { handled: true } if input was a command, false otherwise
export async function dispatchCommand(
  input: string,
  ctx: CommandContext
): Promise<DispatchResult>
{
  const parsed = parseCommand(input)
  if (!parsed) return { handled: false }

  const cmd = findCommand(parsed.name, commands)
  if (!cmd)
  {
    ctx.pushOutput(
      systemBlock(
        `Unknown command: /${parsed.name}\n` +
        `Type ${ocean('/help')} to see available commands.`
      )
    )
    return { handled: true }
  }

  await cmd.execute(parsed.args, ctx)
  return { handled: true }
}
