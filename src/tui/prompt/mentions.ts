// src/tui/prompt/mentions.ts
// parse @-file mentions in a prompt & expand them into attached file context

import {
  readRequiredTextFile,
  type TextFileReadResult,
} from '../../utils/file-read.js'
import {
  decodeMentionPath,
  MENTION_BOUNDARY,
  QUOTED_BODY,
  UNQUOTED_RUN,
} from './mention-path.js'
import { formatAttachedFileBlock } from '../../utils/attached-file.js'
import { MAX_TOOL_OUTPUT_CHARS } from '../../utils/limits.js'
import { truncateToLineBoundary } from '../../utils/truncate-output.js'
import { checkWorkspacePath } from '../../tools/path-policy.js'

const MENTION_PATTERN = new RegExp(
  `${MENTION_BOUNDARY}(?:"(${QUOTED_BODY})"|(${UNQUOTED_RUN}+))`,
  'g'
)

// total @-mention pre-read budget — same scale as one large tool result, so
// attaching files never injects more than a single read would
const MENTION_BUDGET_CHARS = MAX_TOOL_OUTPUT_CHARS

// once this little budget remains, skip the file as over-budget rather than
// inject a useless fragment
const MENTION_MIN_FILE_CHARS = 256

export type MentionSkipReason =
  | 'not found'
  | 'too large'
  | 'binary'
  | 'unreadable'
  | 'outside workspace'
  | 'over budget'

export interface MentionAttachment
{
  path: string
  truncated: boolean
}

export interface MentionSkip
{
  path: string
  reason: MentionSkipReason
}

export interface MentionExpansion
{
  context: string | null
  attached: MentionAttachment[]
  skipped: MentionSkip[]
}

// unique @-mention paths in submission order
export function parseMentions(value: string): string[]
{
  const seen = new Set<string>()
  const paths: string[] = []

  for (const match of value.matchAll(MENTION_PATTERN))
  {
    const path = match[1] !== undefined ? decodeMentionPath(match[1]) : match[2]
    if (path && !seen.has(path))
    {
      seen.add(path)
      paths.push(path)
    }
  }

  return paths
}

// read each mentioned file & format an attachment block for the model. content
// is bounded by a shared budget (earlier mentions win); unreadable, oversized,
// binary, & over-budget files are skipped & reported, never injected
export async function buildMentionContext(
  value: string,
  read: (path: string) => Promise<TextFileReadResult> = readRequiredTextFile,
  budget: number = MENTION_BUDGET_CHARS,
  cwd?: string
): Promise<MentionExpansion>
{
  const paths = parseMentions(value)
  if (paths.length === 0) return { context: null, attached: [], skipped: [] }

  const blocks: string[] = []
  const attached: MentionAttachment[] = []
  const skipped: MentionSkip[] = []
  let used = 0

  for (const path of paths)
  {
    const remaining = budget - used
    if (remaining < MENTION_MIN_FILE_CHARS)
    {
      skipped.push({ path, reason: 'over budget' })
      continue
    }

    let readPath = path
    if (cwd)
    {
      const allowed = await checkWorkspacePath(cwd, path, false)
      if (!allowed.ok)
      {
        skipped.push({ path, reason: 'outside workspace' })
        continue
      }
      readPath = allowed.path
    }

    const result = await read(readPath)
    if (!result.ok)
    {
      const reason: MentionSkipReason =
        result.reason === 'missing'
          ? 'not found'
          : result.reason === 'oversized'
            ? 'too large'
            : 'unreadable'
      skipped.push({ path, reason })
      continue
    }
    // skip binary content read as utf-8; a NUL byte is the cheap tell
    if (result.content.includes('\u0000'))
    {
      skipped.push({ path, reason: 'binary' })
      continue
    }

    const { head: text, truncated } = truncateToLineBoundary(
      result.content,
      remaining
    )
    used += text.length
    blocks.push(formatAttachedFileBlock(path, text, { truncated }))
    attached.push({ path, truncated })
  }

  const context =
    blocks.length > 0
      ? `Referenced files (from @-mentions):\n\n${blocks.join('\n\n')}`
      : null

  return { context, attached, skipped }
}

// one-line transcript notice for truncated/skipped mentions, or null when every
// mention attached cleanly (success is implicit — no need to narrate it)
export function formatMentionNotice(
  expansion: MentionExpansion
): string | null
{
  const parts: string[] = []

  const truncated = expansion.attached
    .filter((a) => a.truncated)
    .map((a) => a.path)
  if (truncated.length > 0)
  {
    parts.push(`truncated to fit context: ${truncated.join(', ')}`)
  }

  if (expansion.skipped.length > 0)
  {
    const plural = expansion.skipped.length === 1 ? '' : 's'
    const list = expansion.skipped
      .map((s) => `${s.path} (${s.reason})`)
      .join(', ')
    parts.push(`skipped @-mention${plural}: ${list}`)
  }

  if (parts.length === 0) return null

  const message = parts.join('; ')
  return message.charAt(0).toUpperCase() + message.slice(1)
}
