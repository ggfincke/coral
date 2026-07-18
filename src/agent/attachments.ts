// src/agent/attachments.ts
// capture workspace attachments & render them within an exact request budget

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkWorkspacePath } from '../tools/path-policy.js'
import { isPathInsideProject } from '../shared/project-tree.js'
import type {
  AttachmentReport,
  AttachmentReportAttached,
  AttachmentReportSkip,
  AttachmentSkipReason,
} from '../types/attachments.js'
import {
  MAX_ATTACHMENT_OMITTED_OVER_BUDGET,
  MAX_ATTACHMENT_REPORT_ITEMS,
  MAX_ATTACHMENT_REPORT_PATH_CHARS,
} from '../types/attachments.js'
import { formatAttachedFileBlock } from '../utils/attached-file.js'
import {
  readRequiredTextFile,
  TEXT_FILE_READ_LIMIT_BYTES,
  type TextFileReadOptions,
  type TextFileReadResult,
} from '../utils/file-read.js'
import { toErrorMessage } from '../utils/errors.js'
import { MAX_TOOL_OUTPUT_CHARS } from '../utils/limits.js'
import { truncateToLineBoundary } from '../utils/truncate-output.js'

export const ATTACHMENT_CONTEXT_HEADING = 'Referenced files (from @-mentions):'
export const MIN_TRUNCATED_ATTACHMENT_BODY_CHARS = 256
export const MAX_ATTACHMENT_FILES = 64
export const MAX_RETAINED_ATTACHMENT_OVERFLOW_REPORTS = 16
export const MAX_ATTACHMENT_CAPTURE_BYTES_HARD = 4 * 1_048_576

const MAX_UTF8_BYTES_PER_RENDERED_CHAR = 4

export type { AttachmentSkipReason } from '../types/attachments.js'

export interface CapturedAttachment
{
  readonly status: 'captured'
  readonly path: string
  readonly resolvedPath: string
  readonly content: string
}

export interface SkippedAttachment
{
  readonly status: 'skipped'
  readonly path: string
  readonly reason: AttachmentSkipReason
  readonly message: string
}

export type AttachmentCaptureEntry = CapturedAttachment | SkippedAttachment

export interface AttachmentCapture
{
  readonly entries: readonly AttachmentCaptureEntry[]
  readonly omittedOverBudget?: number
}

export type MaterializedAttachment = AttachmentReportAttached

export interface AttachmentSkip extends AttachmentReportSkip
{
  readonly message?: string
}

export interface AttachmentMaterialization
{
  readonly context: string | null
  readonly attached: readonly MaterializedAttachment[]
  readonly skipped: readonly AttachmentSkip[]
  readonly usedChars: number
  readonly omittedOverBudget?: number
}

export type AttachmentContextFitPredicate = (context: string | null) => boolean

export type AttachmentReader = (
  path: string,
  options?: TextFileReadOptions
) => Promise<TextFileReadResult>

export interface CaptureAttachmentsOptions
{
  cwd: string
  signal?: AbortSignal
  read?: AttachmentReader
  renderedCharAllowance?: number
}

function frozen<T extends object>(value: T): Readonly<T>
{
  return Object.freeze(value)
}

function isAbortError(error: unknown): boolean
{
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message === 'Aborted')
  )
}

function failureReason(result: Extract<TextFileReadResult, { ok: false }>): {
  reason: AttachmentSkipReason
  message: string
}
{
  if (result.reason === 'missing')
  {
    return { reason: 'not found', message: result.message }
  }
  if (result.reason === 'oversized')
  {
    return { reason: 'too large', message: result.message }
  }
  return { reason: 'unreadable', message: result.message }
}

function skip(
  path: string,
  reason: AttachmentSkipReason,
  message: string
): SkippedAttachment
{
  return frozen({ status: 'skipped', path, reason, message })
}

function normalizedRenderedCharAllowance(value: number | undefined): number
{
  if (value === undefined) return MAX_TOOL_OUTPUT_CHARS
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

// retain one maximum-size candidate plus the worst-case UTF-8 bytes that the
// caller could actually render, then cap hostile or accidental huge allowances
export function attachmentCaptureByteLimit(
  renderedCharAllowance?: number
): number
{
  const allowance = normalizedRenderedCharAllowance(renderedCharAllowance)
  if (allowance === 0) return 0
  return Math.min(
    TEXT_FILE_READ_LIMIT_BYTES + allowance * MAX_UTF8_BYTES_PER_RENDERED_CHAR,
    MAX_ATTACHMENT_CAPTURE_BYTES_HARD
  )
}

async function canonicalExistingPath(
  cwd: string,
  path: string,
  signal?: AbortSignal
): Promise<{ ok: true; path: string } | { ok: false; path: string }>
{
  try
  {
    const [canonicalCwd, canonicalPath] = await Promise.all([
      realpath(cwd),
      realpath(path),
    ])
    signal?.throwIfAborted()
    if (!isPathInsideProject(canonicalCwd, canonicalPath))
    {
      return { ok: false, path: canonicalPath }
    }
    return { ok: true, path: canonicalPath }
  }
  catch
  {
    signal?.throwIfAborted()
    // missing or unreadable paths still flow through the reader for one precise
    // structured failure; lexical normalization has already deduplicated them
    return { ok: true, path }
  }
}

// capture every approved file completely before the caller mutates conversation
// state; abort rejects the whole capture instead of returning a partial result
export async function captureAttachments(
  requestedPaths: readonly string[],
  options: CaptureAttachmentsOptions
): Promise<AttachmentCapture>
{
  const read = options.read ?? readRequiredTextFile
  const entries: AttachmentCaptureEntry[] = []
  const lexicalSeen = new Set<string>()
  const canonicalSeen = new Set<string>()
  const retainedByteLimit = attachmentCaptureByteLimit(
    options.renderedCharAllowance
  )
  let retainedBytes = 0
  let inspectedPaths = 0
  let overflowReports = 0
  let omittedOverBudget = 0

  const recordOverflow = (path: string) =>
  {
    if (overflowReports < MAX_RETAINED_ATTACHMENT_OVERFLOW_REPORTS)
    {
      entries.push(
        skip(
          path,
          'over budget',
          `${path} exceeds the ${MAX_ATTACHMENT_FILES}-file attachment limit`
        )
      )
      overflowReports++
      return
    }
    omittedOverBudget = Math.min(
      omittedOverBudget + 1,
      MAX_ATTACHMENT_OMITTED_OVER_BUDGET
    )
  }

  for (const path of requestedPaths)
  {
    options.signal?.throwIfAborted()
    if (!path) continue

    const lexicalPath = resolve(options.cwd, path)
    if (lexicalSeen.has(lexicalPath)) continue
    lexicalSeen.add(lexicalPath)
    if (inspectedPaths >= MAX_ATTACHMENT_FILES)
    {
      recordOverflow(path)
      continue
    }
    inspectedPaths++

    const allowed = await checkWorkspacePath(options.cwd, path, false)
    options.signal?.throwIfAborted()
    const canonical = await canonicalExistingPath(
      options.cwd,
      allowed.path,
      options.signal
    )
    options.signal?.throwIfAborted()
    if (canonicalSeen.has(canonical.path)) continue
    canonicalSeen.add(canonical.path)
    if (!allowed.ok)
    {
      entries.push(
        skip(
          path,
          'outside workspace',
          allowed.error ?? `Attachment is outside the workspace: ${path}`
        )
      )
      continue
    }
    if (!canonical.ok)
    {
      entries.push(
        skip(
          path,
          'outside workspace',
          `Attachment is outside the workspace through a symlink: ${path}`
        )
      )
      continue
    }
    if (retainedBytes >= retainedByteLimit)
    {
      entries.push(
        skip(
          path,
          'over budget',
          `${path} exceeds the aggregate attachment capture budget`
        )
      )
      continue
    }

    let result: TextFileReadResult
    try
    {
      result = await read(canonical.path, { signal: options.signal })
      options.signal?.throwIfAborted()
    }
    catch (error)
    {
      options.signal?.throwIfAborted()
      if (isAbortError(error)) throw error
      entries.push(
        skip(
          path,
          'unreadable',
          `Failed to read ${canonical.path}: ${toErrorMessage(error)}`
        )
      )
      continue
    }

    if (!result.ok)
    {
      const failure = failureReason(result)
      entries.push(skip(path, failure.reason, failure.message))
      continue
    }
    const capturedBytes = Buffer.byteLength(result.content, 'utf-8')
    if (capturedBytes > TEXT_FILE_READ_LIMIT_BYTES)
    {
      entries.push(
        skip(
          path,
          'too large',
          `${path} exceeds the 1 MiB attachment read limit`
        )
      )
      continue
    }
    if (result.content.includes('\u0000'))
    {
      entries.push(
        skip(
          path,
          'binary',
          `${path} contains binary data and was not attached`
        )
      )
      continue
    }
    if (retainedBytes + capturedBytes > retainedByteLimit)
    {
      entries.push(
        skip(
          path,
          'over budget',
          `${path} exceeds the aggregate attachment capture budget`
        )
      )
      continue
    }

    retainedBytes += capturedBytes
    entries.push(
      frozen({
        status: 'captured',
        path,
        resolvedPath: canonical.path,
        content: result.content,
      })
    )
  }

  options.signal?.throwIfAborted()
  return frozen({
    entries: frozen(entries),
    ...(omittedOverBudget > 0 ? { omittedOverBudget } : {}),
  })
}

function materializationSkip(entry: SkippedAttachment): AttachmentSkip
{
  return frozen({
    path: entry.path,
    reason: entry.reason,
    message: entry.message,
  })
}

function overBudgetSkip(path: string): AttachmentSkip
{
  return frozen({
    path,
    reason: 'over budget',
    message: `${path} did not fit the attachment request budget`,
  })
}

function blockPrefix(hasBlocks: boolean): string
{
  return hasBlocks ? '\n\n' : `${ATTACHMENT_CONTEXT_HEADING}\n\n`
}

// render from immutable captures so exact heading, label, separator, & marker
// costs all count against the caller's character allocation
export function materializeAttachments(
  capture: AttachmentCapture,
  maxChars: number
): AttachmentMaterialization
{
  const budget = Math.max(0, Math.floor(maxChars))
  const blocks: string[] = []
  const attached: MaterializedAttachment[] = []
  const skipped: AttachmentSkip[] = []
  let usedChars = 0

  for (const entry of capture.entries)
  {
    if (entry.status === 'skipped')
    {
      skipped.push(materializationSkip(entry))
      continue
    }

    const prefix = blockPrefix(blocks.length > 0)
    const fullBlock = formatAttachedFileBlock(entry.path, entry.content)
    if (usedChars + prefix.length + fullBlock.length <= budget)
    {
      blocks.push(fullBlock)
      usedChars += prefix.length + fullBlock.length
      attached.push(frozen({ path: entry.path, truncated: false }))
      continue
    }

    const emptyTruncatedBlock = formatAttachedFileBlock(entry.path, '', {
      truncated: true,
    })
    const bodyBudget =
      budget - usedChars - prefix.length - emptyTruncatedBlock.length
    if (bodyBudget < MIN_TRUNCATED_ATTACHMENT_BODY_CHARS)
    {
      skipped.push(overBudgetSkip(entry.path))
      continue
    }

    const truncation = truncateToLineBoundary(entry.content, bodyBudget)
    if (
      !truncation.truncated ||
      truncation.head.length < MIN_TRUNCATED_ATTACHMENT_BODY_CHARS
    )
    {
      skipped.push(overBudgetSkip(entry.path))
      continue
    }

    const truncatedBlock = formatAttachedFileBlock(
      entry.path,
      truncation.head,
      { truncated: true }
    )
    const nextUsedChars = usedChars + prefix.length + truncatedBlock.length
    if (nextUsedChars > budget)
    {
      skipped.push(overBudgetSkip(entry.path))
      continue
    }

    blocks.push(truncatedBlock)
    usedChars = nextUsedChars
    attached.push(frozen({ path: entry.path, truncated: true }))
  }

  const context =
    blocks.length > 0
      ? `${ATTACHMENT_CONTEXT_HEADING}\n\n${blocks.join('\n\n')}`
      : null

  return frozen({
    context,
    attached: frozen(attached),
    skipped: frozen(skipped),
    usedChars: context?.length ?? 0,
    ...(capture.omittedOverBudget === undefined
      ? {}
      : { omittedOverBudget: capture.omittedOverBudget }),
  })
}

function renderAttachmentContext(blocks: readonly string[]): string | null
{
  return blocks.length > 0
    ? `${ATTACHMENT_CONTEXT_HEADING}\n\n${blocks.join('\n\n')}`
    : null
}

function safePrefixEnd(text: string, maxChars: number): number
{
  let end = Math.min(Math.max(Math.floor(maxChars), 0), text.length)
  if (
    end > 0 &&
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[end]!)
  )
  {
    end--
  }
  return end
}

function truncatedBody(text: string, maxChars: number): string | null
{
  const end = safePrefixEnd(text, maxChars)
  if (end <= 0 || end >= text.length) return null
  const truncation = truncateToLineBoundary(text, end)
  if (
    !truncation.truncated ||
    truncation.head.length < MIN_TRUNCATED_ATTACHMENT_BODY_CHARS
  )
  {
    return null
  }
  return truncation.head
}

// fit each mention independently so structural switches between files never
// invalidate the caller's exact monotonic predicate for one nested file prefix
export function materializeAttachmentsToFit(
  capture: AttachmentCapture,
  maxChars: number,
  fits: AttachmentContextFitPredicate
): AttachmentMaterialization
{
  const budget = Math.max(0, Math.floor(maxChars))
  const blocks: string[] = []
  const attached: MaterializedAttachment[] = []
  const skipped: AttachmentSkip[] = []

  for (const entry of capture.entries)
  {
    if (entry.status === 'skipped')
    {
      skipped.push(materializationSkip(entry))
      continue
    }

    const fullBlock = formatAttachedFileBlock(entry.path, entry.content)
    const fullContext = renderAttachmentContext([...blocks, fullBlock])
    if (
      fullContext !== null &&
      fullContext.length <= budget &&
      fits(fullContext)
    )
    {
      blocks.push(fullBlock)
      attached.push(frozen({ path: entry.path, truncated: false }))
      continue
    }

    let low = MIN_TRUNCATED_ATTACHMENT_BODY_CHARS
    let high = Math.min(entry.content.length - 1, budget)
    let bestBlock: string | null = null

    while (low <= high)
    {
      const bodyAllowance = Math.floor((low + high) / 2)
      const body = truncatedBody(entry.content, bodyAllowance)
      if (body === null)
      {
        low = bodyAllowance + 1
        continue
      }

      const block = formatAttachedFileBlock(entry.path, body, {
        truncated: true,
      })
      const context = renderAttachmentContext([...blocks, block])
      if (context !== null && context.length <= budget && fits(context))
      {
        bestBlock = block
        low = bodyAllowance + 1
      }
      else
      {
        high = bodyAllowance - 1
      }
    }

    if (bestBlock === null)
    {
      skipped.push(overBudgetSkip(entry.path))
      continue
    }

    blocks.push(bestBlock)
    attached.push(frozen({ path: entry.path, truncated: true }))
  }

  const context = renderAttachmentContext(blocks)
  return frozen({
    context,
    attached: frozen(attached),
    skipped: frozen(skipped),
    usedChars: context?.length ?? 0,
    ...(capture.omittedOverBudget === undefined
      ? {}
      : { omittedOverBudget: capture.omittedOverBudget }),
  })
}

// strip transient error details before attaching the outcome to saved history
export function attachmentReportFromMaterialization(
  materialization: AttachmentMaterialization
): AttachmentReport
{
  const reportPath = (path: string): string =>
  {
    if (path.length <= MAX_ATTACHMENT_REPORT_PATH_CHARS) return path
    const prefixEnd = safePrefixEnd(path, MAX_ATTACHMENT_REPORT_PATH_CHARS - 1)
    return `${path.slice(0, prefixEnd)}…`
  }
  const attached = materialization.attached.slice(
    0,
    MAX_ATTACHMENT_REPORT_ITEMS
  )
  const remainingItems = MAX_ATTACHMENT_REPORT_ITEMS - attached.length
  const skipped = materialization.skipped.slice(0, remainingItems)
  const omittedOverBudget = Math.min(
    (materialization.omittedOverBudget ?? 0) +
      (materialization.skipped.length - skipped.length),
    MAX_ATTACHMENT_OMITTED_OVER_BUDGET
  )

  return frozen({
    attached: frozen(
      attached.map((entry) =>
        frozen({ path: reportPath(entry.path), truncated: entry.truncated })
      )
    ),
    skipped: frozen(
      skipped.map(({ path, reason }) =>
        frozen({ path: reportPath(path), reason })
      )
    ),
    ...(omittedOverBudget > 0 ? { omittedOverBudget } : {}),
  })
}

// build the complete replacement value so callers can commit it in one write
export function appendAttachmentContext(
  cleanContent: string,
  context: string | null
): string
{
  return context ? `${cleanContent}\n\n${context}` : cleanContent
}
