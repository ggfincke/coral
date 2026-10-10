// src/tui/commands/registry.ts
// canonical slash-command order, parser, and dispatcher

import chalk from 'chalk'
import {
  canonicalSkillName,
  type SkillIndex,
  type SkillRecord,
} from '../../skills/types.js'
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
import { jobsCommand } from './jobs.js'

const SKILL_DETAIL_MAX = 80

export interface SlashSkillResolution
{
  kind: 'skill'
  record: SkillRecord
  args: string
  prompt: string
}

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
    return { name: withoutSlash, args: '' }
  }

  return {
    name: withoutSlash.slice(0, spaceIndex),
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

// headings follow contiguous command groups without changing registry order
const helpSections: Record<string, string> = {
  help: 'Conversation',
  status: 'Runtime',
  undo: 'History and output',
  index: 'Project and sessions',
  telemetry: 'Diagnostics',
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
      const section = helpSections[command.name]
      if (section)
      {
        if (command !== commands[0]) lines.push('')
        lines.push(`  ${chalk.bold(section)}`)
      }
      const aliases = command.aliases?.length
        ? chalk.dim(
            ` (${command.aliases.map((alias) => `/${alias}`).join(', ')})`
          )
        : ''
      lines.push(
        `  ${style('user')(`/${command.name}`)}${aliases}  ${chalk.dim(command.description)}`
      )
    }

    const skillInfos = skillCommandInfos(ctx.agent.getSkills?.()?.records ?? [])
    if (skillInfos.length > 0)
    {
      lines.push('', `${style('muted')('- skills')}`, '')
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
  {
    name: 'queue',
    description:
      'List queued messages or pause/resume/edit/remove/clear pending work',
    execute: (args, ctx) => ctx.manageQueue(args),
  },
  conversationCommands.clear,
  conversationCommands.compact,
  runtimeCommands.status,
  runtimeCommands.mcp,
  runtimeCommands.skills,
  runtimeCommands.model,
  runtimeCommands.permissions,
  runtimeCommands.verify,
  runtimeCommands.theme,
  runtimeCommands.keybindings,
  conversationCommands.undo,
  conversationCommands.redo,
  workspaceCommands.diff,
  conversationCommands.copy,
  conversationCommands.export,
  conversationCommands.raw,
  conversationCommands.vim,
  conversationCommands.todo,
  workspaceCommands.index,
  sessionCommands.sessions,
  sessionCommands.resume,
  sessionCommands.rename,
  sessionCommands.new,
  jobsCommand,
  runtimeCommands.telemetry,
  runtimeCommands.exit,
]

const BUILTIN_NAMES = new Set<string>()
for (const command of commands)
{
  BUILTIN_NAMES.add(command.name)
  for (const alias of command.aliases ?? []) BUILTIN_NAMES.add(alias)
}

function skillCommandInfos(skills: readonly SkillRecord[]): CommandInfo[]
{
  return skills
    .filter((record) => !BUILTIN_NAMES.has(canonicalSkillName(record.name)))
    .map((record) => ({
      name: sanitizeUntrustedText(record.name),
      aliases: [],
      description: excerpt(
        sanitizeUntrustedText(record.description).replace(/\s+/g, ' ').trim(),
        SKILL_DETAIL_MAX
      ),
    }))
}

export function commandCompletions(skills?: SkillIndex): CommandSummary[]
{
  return commandInfos(skills).map((command) => ({
    name: command.name,
    description: command.description,
    aliases: command.aliases,
  }))
}

export function commandInfos(skills?: SkillIndex): CommandInfo[]
{
  return [
    ...commands.map((command) => ({
      name: command.name,
      aliases: command.aliases ?? [],
      description: command.description,
    })),
    ...skillCommandInfos(skills?.records ?? []),
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

// built-ins win; otherwise only an exact case-folded skill name runs, so a
// short or mistyped command can never start a model turn by prefix
export function resolveSlashSkill(
  input: string,
  skills: SkillIndex
): SlashSkillResolution | null
{
  const parsed = parseCommand(input)
  if (!parsed || !parsed.name) return null
  const query = canonicalSkillName(parsed.name)
  if (BUILTIN_NAMES.has(query)) return null

  const record = skills.get(query)
  if (!record) return null
  return {
    kind: 'skill',
    record,
    args: parsed.args,
    prompt: formatSkillInvokePrompt(record, parsed.args),
  }
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
