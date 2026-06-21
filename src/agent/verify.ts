// src/agent/verify.ts
// build the prompt for & parse the verdict from the post-edit self-check

export interface VerificationResult
{
  status: 'pass' | 'fail' | 'unknown'
  // one-line explanation when the check fails
  reason?: string
  editCount: number
  // set when a failed check is feeding back into the model for a fix attempt
  retrying?: boolean
}

// max failed-verify -> fix attempts per run() before warn-only finish
export const MAX_VERIFY_REPROMPTS = 1

// the verdict line the self-check subagent is asked to end w/
const VERDICT_PATTERN = /VERDICT:\s*(PASS|FAIL)\b[ \t]*[-—:]?[ \t]*(.*)/i

// prompt a read-only subagent to review edits against the original request
export function buildVerifyPrompt(request: string, diffs: string[]): string
{
  return [
    'You are reviewing code changes another agent just made, checking whether',
    'they correctly & completely satisfy the original request.',
    '',
    'ORIGINAL REQUEST:',
    request,
    '',
    'CHANGES MADE (unified diffs):',
    diffs.join('\n\n'),
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

// corrective user message after a failed self-check — hands the model the
// reason & asks it to fix or justify, so a weak reviewer's false FAIL doesn't
// force a needless edit
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

// extract the verdict from the subagent's reply — scans from the end since the
// verdict line is the last thing it emits. unknown when no line matches
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
    const reason = match[2]!.trim()
    return {
      status,
      reason: reason.length > 0 ? reason : undefined,
      editCount,
    }
  }

  return { status: 'unknown', editCount }
}
