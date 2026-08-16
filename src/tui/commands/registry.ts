// src/tui/commands/registry.ts
// canonical slash-command order, parser, and dispatcher

import chalk from 'chalk'
import type { SkillRecord } from '../../skills/types.js'
import { excerpt } from '../../utils/ellipsize.js'
import { sanitizeUntrustedText } from '../../utils/untrusted-text.js'
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

const SKILL_DETAIL_MAX = 80

export type SlashSkillResolution =
  | {
      kind: 'skill'
      record: SkillRecord
      args: string
      prompt: string
    }
  | { kind: 'ambiguous'; query: string; names: string[] }

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

    const skillInfos = skillCommandInfos(ctx.agent.getSkills?.() ?? [])
    if (skillInfos.length > 0)
    {
      lines.push('', `${style('muted')('— skills')}`, '')
      for (const skill of skillInfos)
      {
        lines.push(
          `  ${style('user')(`/${skill.name}`)}  ${chalk.dim(skill.description)}`
        )
      }
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
      chalk.dim(
        'Type /command to run. Skill names start a chat turn; other commands are not sent to the model.'
      )
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
  runtimeCommands.skills,
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

const BUILTIN_NAMES = new Set<string>()
for (const command of commands)
{
  BUILTIN_NAMES.add(command.name)
  for (const alias of command.aliases ?? []) BUILTIN_NAMES.add(alias)
}

function isBuiltinPrefix(query: string): boolean
{
  if (!query) return false
  for (const name of BUILTIN_NAMES)
  {
    if (name.startsWith(query)) return true
  }
  return false
}

function skillCommandInfos(
  skills: readonly SkillRecord[] | undefined
): CommandInfo[]
{
  if (!skills || skills.length === 0) return []
  return skills
    .filter((record) => !BUILTIN_NAMES.has(record.name.toLowerCase()))
    .map((record) => ({
      name: sanitizeUntrustedText(record.name),
      aliases: [],
      description: excerpt(
        sanitizeUntrustedText(record.description).replace(/\s+/g, ' ').trim(),
        SKILL_DETAIL_MAX
      ),
    }))
}

export function commandCompletions(
  skills?: readonly SkillRecord[]
): CommandSummary[]
{
  return commandInfos(skills).map((command) => ({
    name: command.name,
    description: command.description,
    aliases: command.aliases,
  }))
}

export function commandInfos(skills?: readonly SkillRecord[]): CommandInfo[]
{
  return [
    ...commands.map((command) => ({
      name: command.name,
      aliases: command.aliases ?? [],
      description: command.description,
    })),
    ...skillCommandInfos(skills),
  ]
}

export function formatSkillInvokePrompt(
  record: SkillRecord,
  extra = ''
): string
{
  const lead = `Use the skill tool to load \`${record.name}\` and follow its instructions.`
  const trimmed = extra.trim()
  return trimmed ? `${lead}\n\n${trimmed}` : lead
}

export function formatAmbiguousSkill(query: string, names: string[]): string
{
  const cleanQuery = sanitizeUntrustedText(query)
  const cleanNames = names.map(sanitizeUntrustedText)
  return (
    `Ambiguous skill /${cleanQuery} — matches: ${cleanNames.join(', ')}\n` +
    `Type the full name, or ${style('user')('/skills')} to list.`
  )
}

// built-ins win on exact name; unique skill prefix is allowed only when the
// token is not also a prefix of a built-in command or alias
export function resolveSlashSkill(
  input: string,
  skills: readonly SkillRecord[]
): SlashSkillResolution | null
{
  const parsed = parseCommand(input)
  if (!parsed || !parsed.name) return null
  if (BUILTIN_NAMES.has(parsed.name)) return null

  const available = skills.filter(
    (record) => !BUILTIN_NAMES.has(record.name.toLowerCase())
  )
  const exact = available.find(
    (record) => record.name.toLowerCase() === parsed.name
  )
  if (exact)
  {
    return {
      kind: 'skill',
      record: exact,
      args: parsed.args,
      prompt: formatSkillInvokePrompt(exact, parsed.args),
    }
  }

  if (isBuiltinPrefix(parsed.name)) return null

  const prefixed = available.filter((record) =>
    record.name.toLowerCase().startsWith(parsed.name)
  )
  if (prefixed.length === 1)
  {
    const record = prefixed[0]!
    return {
      kind: 'skill',
      record,
      args: parsed.args,
      prompt: formatSkillInvokePrompt(record, parsed.args),
    }
  }
  if (prefixed.length > 1)
  {
    return {
      kind: 'ambiguous',
      query: parsed.name,
      names: prefixed
        .map((record) => record.name)
        .sort((a, b) => a.localeCompare(b)),
    }
  }
  return null
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
