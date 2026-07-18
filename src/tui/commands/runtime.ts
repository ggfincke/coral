// src/tui/commands/runtime.ts
// application-runtime and configuration commands

import chalk from 'chalk'
import { savePrefs } from '../../config/prefs.js'
import { OllamaClient } from '../../ollama/client.js'
import { formatTelemetry, loadTelemetry } from '../../telemetry/store.js'
import { toErrorMessage } from '../../utils/errors.js'
import { runGitCommand } from '../../utils/git.js'
import {
  computeTokensPerSecond,
  formatDurationNs,
  formatFrozenPrefixCoverage,
  formatTokenCount,
  formatTokensPerSecond,
} from '../shell/metrics.js'
import { getTheme, setTheme, style } from '../theme.js'
import { findTheme } from '../themes.js'
import type { Command } from './contracts.js'
import { committedSaveWarning, coralHeader, systemBlock } from './output.js'
import {
  describePermissionMode,
  formatMcpStatus,
  formatPermissionsHelp,
  formatThemeList,
  formatUnknownPermissionMode,
} from './runtime-output.js'

// /status command

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

// /mcp command

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

// /model command

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
      const models = await client.listModels(ctx.signal)
      if (ctx.signal?.aborted)
      {
        ctx.pushTerminalOutput(systemBlock('Model switch interrupted'))
        return
      }
      availableModels = models.map((m) => m.name)
    }
    catch
    {
      if (ctx.signal?.aborted)
      {
        ctx.pushTerminalOutput(systemBlock('Model switch interrupted'))
        return
      }
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

    // switch in place while preserving conversation history
    const previousModel = ctx.activeModel
    try
    {
      if (ctx.signal?.aborted)
      {
        ctx.pushTerminalOutput(systemBlock('Model switch interrupted'))
        return
      }
      const result = await ctx.switchModel(resolvedModel)
      if (result.status === 'changed')
      {
        const warning = result.persistence
          ? committedSaveWarning(result.persistence, 'Model changed')
          : null
        ctx.pushTerminalOutput(
          systemBlock(`Switched model: ${previousModel} → ${resolvedModel}`),
          ...(warning ? [warning] : [])
        )
      }
      else if (result.status === 'unchanged')
      {
        ctx.pushOutput(systemBlock(`Already using ${resolvedModel}`))
      }
      else if (result.status === 'busy' && !ctx.signal?.aborted)
      {
        ctx.pushOutput(
          systemBlock('Another session transition is still running.')
        )
      }
      else if (result.status === 'aborted' || ctx.signal?.aborted)
      {
        ctx.pushTerminalOutput(systemBlock('Model switch interrupted'))
      }
    }
    catch (err)
    {
      if (ctx.signal?.aborted)
      {
        ctx.pushTerminalOutput(systemBlock('Model switch interrupted'))
        return
      }
      const msg = toErrorMessage(err)
      ctx.pushOutput(systemBlock(`Failed to switch model: ${msg}`))
    }
  },
}

// /permissions command

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

    // the interactive-session owner emits no-op/success/failure output
    await ctx.setYolo(mode === 'yolo')
  },
}

// /verify command

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

// /theme command

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

// /telemetry command

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

// /exit command

const exitCommand: Command = {
  name: 'exit',
  aliases: ['quit'],
  description: 'Exit Coral',
  execute(_args, ctx)
  {
    ctx.exitApp()
  },
}

export const runtimeCommands = {
  status: statusCommand,
  mcp: mcpCommand,
  model: modelCommand,
  permissions: permissionsCommand,
  verify: verifyCommand,
  theme: themeCommand,
  telemetry: telemetryCommand,
  exit: exitCommand,
} satisfies Record<string, Command>
