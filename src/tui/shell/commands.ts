// src/tui/shell/commands.ts
// slash command registry, parser, & dispatcher

import chalk from 'chalk'
import { savePrefs } from '../../config/prefs.js'
import { getTheme, setTheme, style } from '../theme.js'
import { findTheme } from '../themes.js'
import type { Agent } from '../../agent/agent.js'
import { OllamaClient } from '../../ollama/client.js'
import { listSessions } from '../../session/store.js'
import { resolveResumeSession } from '../../session/resume.js'
import type { OutputBlock, SystemBlock } from '../transcript/transcript.js'
import { runGitCommand } from '../../utils/git.js'
import { copyToClipboard } from '../../utils/clipboard.js'
import { lastAssistantText, lastCodeBlock } from './copy.js'
import { getTodos, clearTodos } from '../../tools/todo-store.js'
import {
  computeTokensPerSecond,
  formatDurationNs,
  formatFrozenPrefixCoverage,
  formatTokenCount,
  formatTokensPerSecond,
} from './metrics.js'
import { pluralize } from '../../utils/pluralize.js'
import { toErrorMessage } from '../../utils/errors.js'
import {
  coralHeader,
  describePermissionMode,
  formatIndexError,
  formatIndexProgress,
  formatIndexResult,
  formatIndexStart,
  formatManualCompactionResult,
  formatMcpStatus,
  formatPermissionsHelp,
  formatThemeList,
  formatTodoList,
  formatTuiResumeResolution,
  formatTuiSessionList,
  formatUnknownPermissionMode,
} from './command-output.js'
import type { CommandSummary } from '../prompt/completion.js'
import { buildIndexer } from '../../retrieval/build.js'
import type { BuiltIndexer } from '../../retrieval/build.js'
import {
  DEFAULT_EMBEDDING_MODEL,
  type IndexStore,
} from '../../retrieval/types.js'
import { formatTelemetry, loadTelemetry } from '../../telemetry/store.js'
import {
  keybindingInfos as sharedKeybindingInfos,
  type KeybindingAction,
  type KeybindingSummary,
} from '../keybindings.js'

export type { KeybindingAction, KeybindingSummary }

export interface CommandInfo extends CommandSummary
{
  aliases: string[]
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
  // rebuild transcript from agent history after undo/redo changes
  rebuildTranscript: () => void
  // zero TUI + agent cumulative token gauges (match resume after undo/redo)
  resetTokenUsage: () => void
  // reopen the model picker
  reopenModelPicker: () => void
  // switch model in-place (keeps conversation history)
  switchModel: (modelName: string) => Promise<void>
  // current session working directory
  getCwd: () => string
  // abort signal for long-running slash commands
  signal?: AbortSignal
  // test seam for index command construction
  buildIndexer?: (
    cwd: string,
    ollamaHost: string,
    signal?: AbortSignal
  ) => BuiltIndexer
  // set the permission mode at runtime
  // owns the full transition: no-op check, success/failure output, containment
  setYolo: (yolo: boolean) => Promise<void>
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
    for (const binding of sharedKeybindingInfos())
    {
      lines.push(
        `  ${style('user')(binding.keys.padEnd(8))} ${chalk.dim(binding.description)}`
      )
    }

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
        `Conversation cleared (${pluralize(cleared, 'message')} removed)`
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

    const result = await ctx.agent.forceCompact(ctx.signal)

    if (!result)
    {
      if (ctx.signal?.aborted)
      {
        ctx.pushOutput(systemBlock('Compaction interrupted'))
        return
      }
      ctx.pushOutput(
        systemBlock('Compaction skipped — not enough context to summarize')
      )
      return
    }

    ctx.rebuildTranscript()
    ctx.saveCurrentSession()
    ctx.pushOutput(systemBlock(formatManualCompactionResult(result)))
  },
}

// ── /status ────────────────────────────────────────────────────────────

const statusCommand: Command = {
  name: 'status',
  description: 'Show model, session, token usage, & working directory',
  async execute(_args, ctx)
  {
    const cwd = ctx.getCwd()
    const model = ctx.activeModel
    const tokens = ctx.agent.getEstimatedTokens()
    const messages = ctx.agent.getMessageCount()
    const session = ctx.sessionLabelId ?? '(unsaved)'
    const permissions = describePermissionMode(ctx.yolo)
    const gitBranch = await getGitBranch(cwd)
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

    // frozen-prefix coverage — only meaningful once compaction has frozen blocks
    const frozen = ctx.agent.getFrozenPrefix()
    if (frozen.summaryBlocks > 0)
    {
      const coverage = formatFrozenPrefixCoverage(
        frozen.tokens,
        frozen.contextWindow,
        frozen.summaryBlocks
      )
      lines.push(`  Frozen prefix:${chalk.dim(` ${coverage}`)}`)
    }

    // reliability-layer counters — only shown once something needed repair
    const reliability = ctx.agent.getReliabilityStats()
    const repairs = reliability.repairedToolCalls + reliability.nameRepairs
    const reliabilityTotal =
      repairs +
      reliability.stallNudges +
      reliability.validationFailures +
      reliability.editRepairs +
      reliability.reprompts +
      reliability.doomLoopTrips +
      reliability.verifyFlags +
      reliability.verifyReprompts
    if (reliabilityTotal > 0)
    {
      const parts = [
        `${repairs} tool-call`,
        `${reliability.stallNudges} nudge`,
        `${reliability.validationFailures} invalid-args`,
      ]
      if (reliability.editRepairs > 0)
      {
        parts.push(`${reliability.editRepairs} edit-fix`)
      }
      if (reliability.reprompts > 0)
      {
        parts.push(`${reliability.reprompts} reprompt`)
      }
      if (reliability.doomLoopTrips > 0)
      {
        parts.push(`${reliability.doomLoopTrips} loop`)
      }
      if (reliability.verifyFlags > 0)
      {
        parts.push(`${reliability.verifyFlags} verify-flag`)
      }
      if (reliability.verifyReprompts > 0)
      {
        parts.push(`${reliability.verifyReprompts} verify-fix`)
      }
      lines.push(`  Repairs:      ${chalk.dim(parts.join(', '))}`)
    }

    if (ctx.agent.getVerifyEdits())
    {
      lines.push(
        `  Self-check:   ${chalk.dim('on (verifies edits, retries on fail)')}`
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

// ── /mcp ──────────────────────────────────────────────────────────────

const mcpCommand: Command = {
  name: 'mcp',
  description: 'Show configured MCP server & tool status',
  execute(_args, ctx)
  {
    ctx.pushOutput(
      systemBlock(formatMcpStatus(ctx.agent.getMcpStatus(), ctx.yolo))
    )
  },
}

// get the current git branch, or null if not in a repo
async function getGitBranch(cwd: string): Promise<string | null>
{
  const result = await runGitCommand(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    cwd,
    {
      timeout: 3000,
    }
  )

  return result.error || !result.output ? null : result.output
}

// ── /telemetry ─────────────────────────────────────────────────────────

const telemetryCommand: Command = {
  name: 'telemetry',
  description: 'Show lifetime reliability counters per model',
  execute(_args, ctx)
  {
    const store = loadTelemetry()
    const lines = [coralHeader('telemetry'), '', ...formatTelemetry(store)]
    ctx.pushOutput(systemBlock(lines.join('\n')))
  },
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
      ctx.saveCurrentSession()
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
  async execute(args, ctx)
  {
    if (!args)
    {
      ctx.pushOutput(systemBlock(formatPermissionsHelp(ctx.yolo)))
      return
    }

    const mode = args.trim().toLowerCase()

    if (mode !== 'yolo' && mode !== 'ask')
    {
      ctx.pushOutput(systemBlock(formatUnknownPermissionMode(mode)))
      return
    }

    // the App-level transition owner emits the no-op/success/failure output
    await ctx.setYolo(mode === 'yolo')
  },
}

// ── /verify ───────────────────────────────────────────────────────────

const verifyCommand: Command = {
  name: 'verify',
  description: 'Toggle the post-edit self-check (off by default)',
  execute(args, ctx)
  {
    const arg = args.trim().toLowerCase()

    if (!arg)
    {
      const state = ctx.agent.getVerifyEdits() ? 'on' : 'off'
      ctx.pushOutput(
        systemBlock(
          `Self-check: ${chalk.bold(state)} — after an edit-producing turn, a ` +
            `read-only subagent reviews the changes against your request; on a ` +
            `FAIL the model gets one chance to fix them\n\n` +
            `  ${style('user')('/verify on')}   — review (& fix) edits before declaring done\n` +
            `  ${style('user')('/verify off')}  — skip the check (faster)`
        )
      )
      return
    }

    if (arg === 'on' || arg === 'off')
    {
      const enabled = arg === 'on'
      ctx.agent.setVerifyEdits(enabled)
      ctx.pushOutput(
        systemBlock(
          `Self-check → ${chalk.bold(arg)}${
            enabled ? ' (edits reviewed after each turn)' : ''
          }`
        )
      )
      return
    }

    ctx.pushOutput(
      systemBlock(
        `Unknown option: "${arg}"\n` +
          `Valid: ${style('user')('on')}, ${style('user')('off')}`
      )
    )
  },
}

// ── /theme ─────────────────────────────────────────────────────────────

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

// ── /undo & /redo ─────────────────────────────────────────────────────

function formatUndoResult(result: {
  message: string
  removedMessages?: number
  restoredMessages?: number
  changedFiles?: number
}): string
{
  const details: string[] = []
  if (result.removedMessages !== undefined)
  {
    details.push(`${pluralize(result.removedMessages, 'message')} removed`)
  }
  if (result.restoredMessages !== undefined)
  {
    details.push(`${pluralize(result.restoredMessages, 'message')} restored`)
  }
  if (result.changedFiles !== undefined)
  {
    details.push(`${pluralize(result.changedFiles, 'file')} updated`)
  }

  return details.length > 0
    ? `${result.message} (${details.join(', ')})`
    : result.message
}

const undoCommand: Command = {
  name: 'undo',
  description:
    'Undo the last turn & revert captured file edits (session snapshots under ~/.coral/sessions/ can duplicate file contents incl. secrets — treat like the workspace)',
  async execute(_args, ctx)
  {
    const result = await ctx.agent.undoLastTurn()
    if (!result.ok)
    {
      ctx.pushOutput(systemBlock(result.message))
      return
    }

    ctx.rebuildTranscript()
    ctx.resetTokenUsage()
    ctx.saveCurrentSession()
    ctx.pushOutput(systemBlock(formatUndoResult(result)))
  },
}

const redoCommand: Command = {
  name: 'redo',
  description: 'Redo the last undone turn & reapply captured edits',
  async execute(_args, ctx)
  {
    const result = await ctx.agent.redoLastTurn()
    if (!result.ok)
    {
      ctx.pushOutput(systemBlock(result.message))
      return
    }

    ctx.rebuildTranscript()
    ctx.resetTokenUsage()
    ctx.saveCurrentSession()
    ctx.pushOutput(systemBlock(formatUndoResult(result)))
  },
}

// ── /diff ──────────────────────────────────────────────────────────────

const diffCommand: Command = {
  name: 'diff',
  description: 'Show git diff of working directory',
  async execute(_args, ctx)
  {
    const cwd = ctx.getCwd()

    const result = await runGitCommand(['diff'], cwd, {
      allowStdoutOnError: true,
    })

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

// ── /copy ──────────────────────────────────────────────────────────────

const copyCommand: Command = {
  name: 'copy',
  description:
    "Copy the last response (or its code block w/ 'code') to clipboard",
  async execute(args, ctx)
  {
    const text = lastAssistantText(ctx.agent.getMessages())
    if (!text)
    {
      ctx.pushOutput(systemBlock('Nothing to copy — no response yet'))
      return
    }

    const wantCode = args.trim().toLowerCase() === 'code'
    let payload = text
    let label = 'response'

    if (wantCode)
    {
      const block = lastCodeBlock(text)
      if (!block)
      {
        ctx.pushOutput(systemBlock('No code block in the last response'))
        return
      }
      payload = block
      label = 'code block'
    }

    const result = await copyToClipboard(payload)
    if (!result.ok)
    {
      ctx.pushOutput(
        systemBlock(
          `Failed to copy: ${result.error ?? 'clipboard unavailable'}`
        )
      )
      return
    }

    const lineCount = payload.split('\n').length
    const detail = pluralize(lineCount, 'line')
    ctx.pushOutput(systemBlock(`Copied last ${label} to clipboard (${detail})`))
  },
}

// ── /todo ──────────────────────────────────────────────────────────────

const todoCommand: Command = {
  name: 'todo',
  description: 'Show the task list, or clear it w/ /todo clear',
  execute(args, ctx)
  {
    const arg = args.trim().toLowerCase()

    if (arg === 'clear')
    {
      clearTodos()
      // flush the cleared list to disk so resume doesn't bring it back
      ctx.saveCurrentSession()
      ctx.pushOutput(systemBlock('Task list cleared'))
      return
    }

    if (arg)
    {
      ctx.pushOutput(
        systemBlock(
          `Unknown option: "${arg}"\n` +
            `Usage: ${style('user')('/todo')} or ${style('user')('/todo clear')}`
        )
      )
      return
    }

    const todos = getTodos()
    if (todos.length === 0)
    {
      ctx.pushOutput(systemBlock('No tasks yet'))
      return
    }

    ctx.pushOutput(systemBlock(formatTodoList(todos)))
  },
}

// ── /index ─────────────────────────────────────────────────────────────

// guards against a re-entrant build — slash commands run w/ input unlocked,
// so a second /index (or a chat turn) could otherwise overlap the first
let indexBuilding = false

const indexCommand: Command = {
  name: 'index',
  description:
    'Build the semantic code index (/index rebuild forces a rebuild)',
  async execute(args, ctx)
  {
    if (indexBuilding)
    {
      ctx.pushOutput(systemBlock('Index build already in progress'))
      return
    }

    const arg = args.trim().toLowerCase()
    if (arg && arg !== 'rebuild' && arg !== 'force')
    {
      ctx.pushOutput(
        systemBlock(
          `Unknown option: "${arg}"\n` +
            `Usage: ${style('user')('/index')} or ${style('user')('/index rebuild')}`
        )
      )
      return
    }

    const force = arg === 'rebuild' || arg === 'force'
    const cwd = ctx.getCwd()
    let store: IndexStore | undefined
    let embeddingModel = DEFAULT_EMBEDDING_MODEL

    indexBuilding = true
    ctx.pushOutput(systemBlock(formatIndexStart(cwd, force)))

    try
    {
      const build = ctx.buildIndexer ?? buildIndexer
      const built = build(cwd, ctx.host, ctx.signal)
      store = built.store
      embeddingModel = built.embeddingModel

      const stats = await built.indexer.ensureIndexed({
        force,
        onProgress: (progress) =>
        {
          // ~10 throttled updates on big repos; quiet on small ones
          if (progress.total < 20) return
          const step = Math.max(1, Math.floor(progress.total / 10))
          if (
            progress.processed % step === 0 &&
            progress.processed < progress.total
          )
          {
            ctx.pushOutput(
              systemBlock(
                formatIndexProgress(progress.processed, progress.total)
              )
            )
          }
        },
      })

      ctx.pushOutput(systemBlock(formatIndexResult(stats)))
    }
    catch (err)
    {
      ctx.pushOutput(
        systemBlock(formatIndexError(embeddingModel, toErrorMessage(err)))
      )
    }
    finally
    {
      store?.close?.()
      indexBuilding = false
    }
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

    ctx.pushOutput(
      systemBlock(formatTuiSessionList(sessions, ctx.sessionLabelId))
    )
  },
}

// ── /resume ───────────────────────────────────────────────────────────

const resumeCommand: Command = {
  name: 'resume',
  description: 'Resume a saved session (no args = latest)',
  execute(args, ctx)
  {
    const target = resolveResumeSession({
      requestedId: args,
      currentSessionId: ctx.sessionLabelId,
      allowPrefix: true,
      requireExistingCwd: true,
    })

    if (target.type !== 'target')
    {
      ctx.pushOutput(systemBlock(formatTuiResumeResolution(target)))
      return
    }

    ctx.saveCurrentSession()

    if (ctx.resumeSession(target.session.id))
    {
      ctx.pushOutput(systemBlock(formatTuiResumeResolution(target)))
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
      `New conversation started (${pluralize(cleared, 'message')} cleared)`
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
  mcpCommand,
  modelCommand,
  permissionsCommand,
  verifyCommand,
  themeCommand,
  undoCommand,
  redoCommand,
  diffCommand,
  copyCommand,
  todoCommand,
  indexCommand,
  sessionsCommand,
  resumeCommand,
  renameCommand,
  newCommand,
  telemetryCommand,
  exitCommand,
]

// command name + description pairs for prompt autocomplete
export function commandCompletions(): CommandSummary[]
{
  return commandInfos().map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    aliases: cmd.aliases,
  }))
}

export function commandInfos(): CommandInfo[]
{
  return commands.map((cmd) => ({
    name: cmd.name,
    aliases: cmd.aliases ?? [],
    description: cmd.description,
  }))
}

export function keybindingInfos(): KeybindingSummary[]
{
  return sharedKeybindingInfos()
}

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
