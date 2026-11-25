// src/agent/loop/edit-verification.ts
// build the post-edit verification prompt and parse its verdict

import { CHARS_PER_TOKEN } from '../../utils/limits.js'

export interface VerificationResult
{
  status: 'pass' | 'fail' | 'unknown'
  // one-line explanation when the check fails
  reason?: string
  editCount: number
  // set when a failed check is feeding back into the model for a fix attempt
  retrying?: boolean
  // the check itself could not run (status stays unknown); reason holds why
  errored?: boolean
}

// cap failed-verification fix attempts before a warn-only finish
export const MAX_VERIFY_REPROMPTS = 1

// the verdict line the self-check subagent must end with; local models often
// bold it or inflect the keyword, so emphasis and a trailing ED are tolerated
const VERDICT_PATTERN = /VERDICT[*_]*[ \t]*:[*_ \t]*(PASS|FAIL)(?:ED)?\b(.*)/i

// emphasis and separators around the reason, never part of it
const REASON_LEAD_PATTERN = /^[\s*_]*[-:\u2014]?[\s*]*/
const REASON_TAIL_PATTERN = /[\s*]+$/

// share of the subagent's prompt limit the joined diffs may fill, leaving the
// rest for its system prompt, tool schemas, and file re-reads
const VERIFY_DIFF_PROMPT_SHARE = 0.5

// cut the joined diffs at a line boundary once they pass the review budget
function boundDiffs(diffs: string[], maxChars: number): string
{
  const joined = diffs.join('\n\n')
  if (joined.length <= maxChars) return joined

  const lineEnd = joined.lastIndexOf('\n', maxChars)
  const kept = joined.slice(0, lineEnd > 0 ? lineEnd : Math.max(maxChars, 0))
  return `${kept}\n[diffs truncated to fit the review; re-read the changed files for the rest]`
}

// prompt a read-only subagent to review edits against the original request,
// keeping the diffs within a share of the subagent's prompt token limit
export function buildVerifyPrompt(
  request: string,
  diffs: string[],
  promptLimit: number
): string
{
  const maxDiffChars = Math.floor(
    promptLimit * VERIFY_DIFF_PROMPT_SHARE * CHARS_PER_TOKEN
  )
  return [
    'You are reviewing code changes another agent just made, checking whether',
    'they correctly & completely satisfy the original request.',
    '',
    'ORIGINAL REQUEST:',
    request,
    '',
    'CHANGES MADE (unified diffs):',
    boundDiffs(diffs, maxDiffChars),
    '',
    'Re-read the changed files if you need surrounding context. Look for logic',
    'errors, missed requirements, broken syntax, & edits that contradict the',
    'request. Do not nitpick style or suggest unrelated improvements.',
    '',
    'End your reply with a single line, exactly one of:',
    'VERDICT: PASS',
    'VERDICT: FAIL - <one-line reason>',
  ].join('\n')
}

// return a corrective message after a failed self-check
export function buildVerifyReprompt(reason?: string): string
{
  const problem = reason
    ? `A self-check of your changes found a problem: ${reason}.`
    : 'A self-check of your changes flagged a possible problem.'
  return (
    `${problem} Re-examine the files you changed against the original ` +
    'request, fix anything wrong or incomplete, then give your final answer. ' +
    'If the changes are actually correct, briefly explain why instead.'
  )
}

// extract the final verdict line, or return unknown when none matches
export function parseVerifyVerdict(
  text: string,
  editCount: number
): VerificationResult
{
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--)
  {
    const match = lines[i]!.match(VERDICT_PATTERN)
    if (!match) continue

    const status = match[1]!.toUpperCase() === 'PASS' ? 'pass' : 'fail'
    const reason = match[2]!
      .replace(REASON_LEAD_PATTERN, '')
      .replace(REASON_TAIL_PATTERN, '')
    return {
      status,
      reason: reason.length > 0 ? reason : undefined,
      editCount,
    }
  }

  return { status: 'unknown', editCount }
}
