// src/tui/commands.ts
// slash command registry, parser, & dispatcher

import chalk from 'chalk'
import { execSync } from 'node:child_process'
import { getCwd } from '../cwd.js'
import { coral, ocean, sand } from './theme.js'
import type { Agent } from '../agent/agent.js'
import { OllamaClient } from '../ollama/client.js'
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
    lines.push(`  ${ocean('↑↓')}       ${chalk.dim('Scroll transcript when input is empty')}`)
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

    const lines: string[] = [
      `${coral('Coral')} ${sand('— status')}`,
      '',
      `  Model:        ${chalk.white(model)}`,
      `  Permissions:  ${ctx.yolo ? chalk.yellow(permissions) : chalk.dim(permissions)}`,
      `  Session:      ${chalk.dim(session)}`,
      `  Messages:     ${chalk.dim(String(messages))}`,
      `  Tokens (est): ${chalk.dim(`~${formatTokenCount(tokens)}`)}`,
      `  CWD:          ${chalk.dim(cwd)}`,
    ]

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
