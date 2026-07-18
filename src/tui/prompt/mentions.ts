// src/tui/prompt/mentions.ts
// parse @-file mention syntax & format transcript notices

import type {
  AttachmentReport,
  AttachmentReportAttached,
  AttachmentReportSkip,
  AttachmentSkipReason,
} from '../../types/attachments.js'
import {
  decodeMentionPath,
  MENTION_BOUNDARY,
  QUOTED_BODY,
  UNQUOTED_RUN,
} from './mention-path.js'

const MENTION_PATTERN = new RegExp(
  `${MENTION_BOUNDARY}(?:"(${QUOTED_BODY})"|(${UNQUOTED_RUN}+))`,
  'g'
)

export type MentionSkipReason = AttachmentSkipReason
export type MentionAttachment = AttachmentReportAttached
export type MentionSkip = AttachmentReportSkip
export type MentionExpansion = Pick<
  AttachmentReport,
  'attached' | 'skipped' | 'omittedOverBudget'
>

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

  if ((expansion.omittedOverBudget ?? 0) > 0)
  {
    const count = expansion.omittedOverBudget!
    parts.push(
      `${count} additional @-mention${count === 1 ? '' : 's'} skipped (over budget)`
    )
  }

  if (parts.length === 0) return null

  const message = parts.join('; ')
  return message.charAt(0).toUpperCase() + message.slice(1)
}
