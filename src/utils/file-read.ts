// src/utils/file-read.ts
// text-file read helpers w/ explicit safety modes

import { readFile, stat } from 'node:fs/promises'
import { resolvePath } from '../cwd.js'
import { formatBytes } from './bytes.js'
import { toErrorMessage } from './errors.js'

const BYTES_PER_MB = 1_048_576

export const TEXT_FILE_READ_LIMIT_BYTES = BYTES_PER_MB

export type TextFileReadFailureReason = 'missing' | 'oversized' | 'unreadable'

export interface TextFileReadSuccess
{
  ok: true
  path: string
  content: string
  existed: boolean
}

export interface TextFileReadFailure
{
  ok: false
  path: string
  reason: TextFileReadFailureReason
  message: string
  size?: number
  limit?: number
}

export type TextFileReadResult = TextFileReadSuccess | TextFileReadFailure

export interface TextFileReadOptions
{
  cwd?: string
  signal?: AbortSignal
}

function isMissing(err: unknown): boolean
{
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function oversizedFailure(path: string, size: number): TextFileReadFailure
{
  const sizeLabel = formatBytes(size)
  const limitLabel = formatBytes(TEXT_FILE_READ_LIMIT_BYTES)
  return {
    ok: false,
    path,
    reason: 'oversized',
    message: `${path} is ${sizeLabel}, exceeds ${limitLabel} read limit`,
    size,
    limit: TEXT_FILE_READ_LIMIT_BYTES,
  }
}

async function readTextFile(
  rawPath: string,
  missingAsEmpty: boolean,
  options: TextFileReadOptions = {}
): Promise<TextFileReadResult>
{
  const path = resolvePath(rawPath, options.cwd)
  options.signal?.throwIfAborted()
  let size: number
  try
  {
    const stats = await stat(path)
    options.signal?.throwIfAborted()
    size = stats.size
  }
  catch (err)
  {
    options.signal?.throwIfAborted()
    if (missingAsEmpty && isMissing(err))
    {
      return { ok: true, path, content: '', existed: false }
    }

    return {
      ok: false,
      path,
      reason: isMissing(err) ? 'missing' : 'unreadable',
      message: `Failed to read ${path}: ${toErrorMessage(err)}`,
    }
  }

  if (size > TEXT_FILE_READ_LIMIT_BYTES)
  {
    return oversizedFailure(path, size)
  }

  try
  {
    const content = await readFile(path, {
      encoding: 'utf-8',
      signal: options.signal,
    })
    options.signal?.throwIfAborted()
    return { ok: true, path, content, existed: true }
  }
  catch (err)
  {
    options.signal?.throwIfAborted()
    return {
      ok: false,
      path,
      reason: 'unreadable',
      message: `Failed to read ${path}: ${toErrorMessage(err)}`,
    }
  }
}

export function formatRequiredTextFileError(
  failure: TextFileReadFailure
): string
{
  if (failure.reason === 'oversized')
  {
    return `${failure.message}. Use bash w/ head/tail to read a portion.`
  }

  return failure.message
}

export function formatPreviewSkipMessage(failure: TextFileReadFailure): string
{
  if (failure.reason === 'missing')
  {
    return 'Preview skipped: target file does not exist.'
  }

  return `Preview skipped: ${failure.message}.`
}

export function formatDiffSkipMessage(failure: TextFileReadFailure): string
{
  if (failure.reason === 'missing')
  {
    return 'Diff skipped: previous file does not exist.'
  }
  if (failure.reason === 'oversized')
  {
    return `Diff skipped: previous file ${failure.message}.`
  }

  return `Diff skipped: ${failure.message}.`
}

export function readRequiredTextFile(
  rawPath: string,
  options: TextFileReadOptions = {}
): Promise<TextFileReadResult>
{
  return readTextFile(rawPath, false, options)
}

export function readOptionalPreviousTextFile(
  rawPath: string,
  options: TextFileReadOptions = {}
): Promise<TextFileReadResult>
{
  return readTextFile(rawPath, true, options)
}
