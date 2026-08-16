// tests/scripts/mlx-benchmark/report.ts
// concise durable Markdown rendering for a machine decision

import type { BenchmarkDecision, ModelPair } from './types.js'

function percent(value: number): string
{
  return `${(value * 100).toFixed(1)}%`
}

export function formatDecisionMarkdown(decision: BenchmarkDecision): string
{
  const lines = [
    '# MLX benchmark decision',
    '',
    `- Run: \`${decision.runId}\``,
    `- Verdict: **${decision.verdict.toUpperCase()}**`,
    `- Baseline: \`${decision.baselineTopologyId || 'unavailable'}\``,
    `- Selected: \`${decision.selectedTopologyId ?? 'none'}\``,
    `- Generated: ${decision.generatedAt}`,
    '',
  ]

  for (const candidate of decision.candidates)
  {
    lines.push(`## ${candidate.topologyId}`, '')
    lines.push(
      `- Hard gates: ${candidate.hardGatesPassed ? 'pass' : 'fail'}`,
      `- Performance bounds: ${candidate.performancePassed ? 'pass' : 'fail'}`,
      `- Material improvement: ${candidate.materialImprovement ? 'pass' : 'fail'}`,
      ''
    )
    if (candidate.metrics.length > 0)
    {
      lines.push(
        '| Metric | Estimate | 95% lower | 95% upper |',
        '|---|---:|---:|---:|'
      )
      for (const metric of candidate.metrics)
      {
        lines.push(
          `| ${metric.metric} | ${percent(metric.aggregate.estimate)} | ` +
            `${percent(metric.aggregate.lower)} | ${percent(metric.aggregate.upper)} |`
        )
      }
      lines.push('')
    }
    if (candidate.failures.length > 0)
    {
      lines.push('Failures:', '')
      for (const failure of candidate.failures) lines.push(`- ${failure}`)
      lines.push('')
    }
  }

  if (decision.failures.length > 0)
  {
    lines.push('## Decision failures', '')
    for (const failure of decision.failures) lines.push(`- ${failure}`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function formatForensicMarkdown(
  findings: Array<{
    topologyId: string
    immutableRevision: string
    disposition: string
    findings: string[]
  }>
): string
{
  if (findings.length === 0) return ''
  const lines = ['## Forensic topology', '']
  for (const finding of findings)
  {
    lines.push(
      `### ${finding.topologyId}`,
      '',
      `- Revision: \`${finding.immutableRevision}\``,
      `- Disposition: **${finding.disposition}**`,
      ''
    )
    for (const detail of finding.findings) lines.push(`- ${detail}`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function formatModelEvidenceMarkdown(pairs: ModelPair[]): string
{
  if (pairs.length === 0) return ''
  const lines = ['## Local model evidence', '']
  for (const pair of pairs)
  {
    lines.push(`### ${pair.id}`, '')
    for (const detail of pair.localEvidence) lines.push(`- ${detail}`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
