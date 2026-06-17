// src/agent/verify.ts
// build the prompt for & parse the verdict from the post-edit self-check

export interface VerificationResult
{
  status: 'pass' | 'fail' | 'unknown'
  // one-line explanation when the check fails
  reason?: string
  editCount: number
}

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
