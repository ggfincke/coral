// src/tui/commands/registry.ts
// canonical slash-command order, parser, and dispatcher

import chalk from 'chalk'
import {
  keybindingInfos as sharedKeybindingInfos,
  type KeybindingSummary,
} from '../input/keybindings.js'
import type { CommandSummary } from '../prompt/completion.js'
import { style } from '../theme.js'
import { conversationCommands } from './conversation.js'
import type {
  Command,
  CommandContext,
  CommandInfo,
  ParsedCommand,
} from './contracts.js'
import { coralHeader, systemBlock } from './output.js'
import { runtimeCommands } from './runtime.js'
import { sessionCommands } from './sessions.js'
import { workspaceCommands } from './workspace.js'

// parse one slash command from terminal input
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

// resolve a canonical command name or alias
function findCommand(
  name: string,
  registered: readonly Command[]
): Command | undefined
{
  const lower = name.toLowerCase()
  return registered.find(
    (command) =>
      command.name === lower ||
      command.aliases?.some((alias) => alias === lower)
  )
}

// /help reflects this module's canonical order
const helpCommand: Command = {
  name: 'help',
  description: 'List available commands & keybindings',
  execute(_args, ctx)
  {
    const lines: string[] = [coralHeader('available commands'), '']

    for (const command of commands)
    {
      const aliases = command.aliases?.length
        ? chalk.dim(
            ` (${command.aliases.map((alias) => `/${alias}`).join(', ')})`
          )
        : ''
      lines.push(
        `  ${style('user')(`/${command.name}`)}${aliases}  ${chalk.dim(command.description)}`
      )
    }

    lines.push('', `${style('muted')('— keybindings')}`, '')
    for (const binding of sharedKeybindingInfos())
    {
      lines.push(
        `  ${style('user')(binding.keys.padEnd(8))} ${chalk.dim(binding.description)}`
      )
    }

    lines.push(
      '',
      chalk.dim('Type /command to run. Commands are not sent to the model.')
    )
    ctx.pushOutput(systemBlock(lines.join('\n')))
  },
}

// preserve this exact order across help, completion, palette, and dispatch
const commands: readonly Command[] = [
  helpCommand,
  conversationCommands.clear,
  conversationCommands.compact,
  runtimeCommands.status,
  runtimeCommands.mcp,
  runtimeCommands.model,
  runtimeCommands.permissions,
  runtimeCommands.verify,
  runtimeCommands.theme,
  conversationCommands.undo,
  conversationCommands.redo,
  workspaceCommands.diff,
  conversationCommands.copy,
  conversationCommands.todo,
  workspaceCommands.index,
  sessionCommands.sessions,
  sessionCommands.resume,
  sessionCommands.rename,
  sessionCommands.new,
  runtimeCommands.telemetry,
  runtimeCommands.exit,
]

export function commandCompletions(): CommandSummary[]
{
  return commandInfos().map((command) => ({
    name: command.name,
    description: command.description,
    aliases: command.aliases,
  }))
}

export function commandInfos(): CommandInfo[]
{
  return commands.map((command) => ({
    name: command.name,
    aliases: command.aliases ?? [],
    description: command.description,
  }))
}

export function keybindingInfos(): KeybindingSummary[]
{
  return sharedKeybindingInfos()
}

// dispatch slash input and report whether it was consumed
export async function dispatchCommand(
  input: string,
  ctx: CommandContext
): Promise<boolean>
{
  const parsed = parseCommand(input)
  if (!parsed) return false

  const command = findCommand(parsed.name, commands)
  if (!command)
  {
    ctx.pushOutput(
      systemBlock(
        `Unknown command: /${parsed.name}\n` +
          `Type ${style('user')('/help')} to see available commands.`
      )
    )
    return true
  }

  await command.execute(parsed.args, ctx)
  return true
}
