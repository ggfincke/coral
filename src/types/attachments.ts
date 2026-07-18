// src/types/attachments.ts
// ui-only attachment outcome contracts shared across persistence & transcript layers

export const ATTACHMENT_SKIP_REASONS = [
  'not found',
  'too large',
  'binary',
  'unreadable',
  'outside workspace',
  'over budget',
] as const

export const MAX_ATTACHMENT_REPORT_ITEMS = 80
export const MAX_ATTACHMENT_REPORT_PATH_CHARS = 4_096
export const MAX_ATTACHMENT_OMITTED_OVER_BUDGET = 1_000_000

export type AttachmentSkipReason = (typeof ATTACHMENT_SKIP_REASONS)[number]

export interface AttachmentReportAttached
{
  readonly path: string
  readonly truncated: boolean
}

export interface AttachmentReportSkip
{
  readonly path: string
  readonly reason: AttachmentSkipReason
}

export interface AttachmentReport
{
  readonly attached: readonly AttachmentReportAttached[]
  readonly skipped: readonly AttachmentReportSkip[]
  readonly omittedOverBudget?: number
}

export function isAttachmentSkipReason(
  value: unknown
): value is AttachmentSkipReason
{
  return (
    typeof value === 'string' &&
    (ATTACHMENT_SKIP_REASONS as readonly string[]).includes(value)
  )
}

export function cloneAttachmentReport(
  report: AttachmentReport
): AttachmentReport
{
  return {
    attached: report.attached.map((entry) => ({ ...entry })),
    skipped: report.skipped.map((entry) => ({ ...entry })),
    ...(report.omittedOverBudget === undefined
      ? {}
      : { omittedOverBudget: report.omittedOverBudget }),
  }
}
