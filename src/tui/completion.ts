// src/tui/completion.ts
// pure completion logic for slash commands & @-file mentions in the prompt

import { decodeMentionPath, encodeMentionPath } from './mention-path.js'

export type CompletionKind = 'command' | 'file'

// an active completion span detected under the cursor
export interface CompletionQuery
{
  kind: CompletionKind
  // query text w/o the leading sigil (e.g. 'sta' for '/sta', 'src/fo' for '@src/fo')
  token: string
  // index of the sigil; start of the replaceable span
  start: number
  // end of the replaceable span (the cursor offset)
  end: number
}

// a single suggestion row
export interface CompletionItem
{
  // text inserted after the sigil
  value: string
  // display label (command name or file path)
  label: string
  // secondary text (command description)
  detail?: string
}

export interface CommandSummary
{
  name: string
  description: string
}

const MAX_RESULTS = 8

// detect a slash-command or @-file completion span ending at the cursor
// returns null when nothing under the cursor is completable
export function detectCompletion(
  value: string,
  cursorOffset: number
): CompletionQuery | null
{
  const before = value.slice(0, cursorOffset)

  // slash command: '/' + a single unbroken word, allowing leading whitespace
  // (dispatch trims, so '  /help' is a real command — keep the menu in sync)
  const command = /^(\s*)\/(\S*)$/.exec(before)
  if (command)
  {
    return {
      kind: 'command',
      token: command[2] ?? '',
      start: (command[1] ?? '').length,
      end: cursorOffset,
    }
  }

  const quotedMention = /(?:^|\s)@"((?:\\.|[^"\\])*)$/.exec(before)
  if (quotedMention)
  {
    const rawToken = quotedMention[1] ?? ''
    return {
      kind: 'file',
      token: decodeMentionPath(rawToken),
      start: cursorOffset - rawToken.length - 2,
      end: cursorOffset,
    }
  }

  // @-mention: '@' at line start or after whitespace, then a non-space run
  const mention = /(?:^|\s)@(\S*)$/.exec(before)
  if (mention)
  {
    const token = mention[1] ?? ''
    return {
      kind: 'file',
      token,
      start: cursorOffset - token.length - 1,
      end: cursorOffset,
    }
  }

  return null
}

// rank slash commands by a query token; prefix matches first, then substring
export function rankCommands(
  token: string,
  commands: CommandSummary[]
): CompletionItem[]
{
  const query = token.toLowerCase()
  const prefix: CompletionItem[] = []
  const substring: CompletionItem[] = []

  for (const command of commands)
  {
    const name = command.name.toLowerCase()
    const item: CompletionItem = {
      value: command.name,
      label: command.name,
      detail: command.description,
    }

    if (!query || name.startsWith(query))
    {
      prefix.push(item)
    }
    else if (name.includes(query))
    {
      substring.push(item)
    }
  }

  return [...prefix, ...substring].slice(0, MAX_RESULTS)
}

// score a path against a query: lower is better, -1 means no match
function scoreFilePath(path: string, query: string): number
{
  const lowerPath = path.toLowerCase()
  const base = lowerPath.slice(lowerPath.lastIndexOf('/') + 1)

  if (lowerPath.startsWith(query)) return 0
  if (base.startsWith(query)) return 1
  if (base.includes(query)) return 2
  if (lowerPath.includes(query)) return 3
  return -1
}

// rank project files by a query token; basename beats deep-path matches,
// ties broken by shorter path. empty token returns the first files in walk order
export function rankFiles(token: string, files: string[]): CompletionItem[]
{
  if (!token)
  {
    return files
      .slice(0, MAX_RESULTS)
      .map((path) => ({ value: path, label: path }))
  }

  const query = token.toLowerCase()
  const scored: { path: string; score: number }[] = []

  for (const path of files)
  {
    const score = scoreFilePath(path, query)
    if (score >= 0) scored.push({ path, score })
  }

  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length)

  return scored
    .slice(0, MAX_RESULTS)
    .map(({ path }) => ({ value: path, label: path }))
}

// splice a chosen item into the prompt, keeping the sigil & adding a trailing space
export function applyCompletion(
  value: string,
  query: CompletionQuery,
  item: CompletionItem
): { value: string; cursorOffset: number }
{
  const sigil = query.kind === 'command' ? '/' : '@'
  const insertedValue =
    query.kind === 'file' ? encodeMentionPath(item.value) : item.value
  const inserted = `${sigil}${insertedValue} `
  const next = value.slice(0, query.start) + inserted + value.slice(query.end)
  return { value: next, cursorOffset: query.start + inserted.length }
}
