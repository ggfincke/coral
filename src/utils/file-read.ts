// src/utils/file-read.ts
// bounded regular-file reads, checked overwrites, and text-file helpers

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { resolvePath } from '../cwd.js'
import { isPathInsideProject } from './path-containment.js'
import { formatBytes } from './bytes.js'
import { toErrorMessage } from './errors.js'

const BYTES_PER_MB = 1_048_576

export const TEXT_FILE_READ_LIMIT_BYTES = BYTES_PER_MB

// O_NONBLOCK keeps a FIFO from hanging open(); O_NOFOLLOW pins the real path
const REGULAR_FILE_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

// no O_TRUNC: nothing changes until the opened fd passes its checks
const REGULAR_FILE_WRITE_FLAGS =
  constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

// for new files: O_EXCL & O_NOFOLLOW fail on any entry planted at the final
// component after the caller's checks; a swapped parent dir is not covered
export const EXCLUSIVE_CREATE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW

export type TextFileReadFailureReason = 'missing' | 'oversized' | 'unreadable'

export interface TextFileReadSuccess
{
  ok: true
  path: string
  content: string
  existed: boolean
  // set when invalid UTF-8 bytes were replaced w/ U+FFFD; writing content back
  // would change the file's bytes
  lossy?: true
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
  // when set, the file's real path must stay inside this directory's real path
  root?: string
  signal?: AbortSignal
}

export interface RegularFileOpenOptions
{
  // when set, the file's real path must stay inside this directory's real path
  root?: string
  signal?: AbortSignal
}

/** A regular file opened by its real path; the caller closes `handle`. */
export interface OpenedRegularFile
{
  path: string
  handle: FileHandle
  stats: Stats
}

export interface BoundedBytes
{
  bytes: Buffer
  // the file held more than the limit; `bytes` is the first `limit` bytes
  truncated: boolean
}

// thrown when a path names something other than a regular file in bounds
class RegularFileError extends Error
{
  readonly code = 'EREGULARFILE'
}

// the path's real target sits outside the caller's root
class OutsideRootError extends RegularFileError
{}

export function isOutsideRootError(err: unknown): boolean
{
  return err instanceof OutsideRootError
}

function confinedTarget(target: string, realRoot: string | null): void
{
  if (realRoot !== null && !isPathInsideProject(realRoot, target))
  {
    throw new OutsideRootError(`${target} resolves outside ${realRoot}`)
  }
}

// real paths of the target & root, taken before open and again after it
interface ResolvedPaths
{
  target: string
  root: string | null
}

// the fd must still be the regular file the real path names, and the path &
// root must resolve as before, so a file or parent dir swapped mid-open fails
function checkOpenedFile(
  before: ResolvedPaths,
  after: ResolvedPaths,
  opened: Stats,
  current: Stats
): void
{
  if (before.target !== after.target || before.root !== after.root)
  {
    throw new RegularFileError(`${before.target} changed while opening`)
  }
  if (
    !opened.isFile() ||
    !current.isFile() ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino
  )
  {
    throw new RegularFileError(`${before.target} is not a regular file`)
  }
}

async function resolvePaths(
  path: string,
  root: string | undefined
): Promise<ResolvedPaths>
{
  const [target, realRoot] = await Promise.all([
    realpath(path),
    root === undefined ? null : realpath(root),
  ])
  return { target, root: realRoot }
}

function resolvePathsSync(
  path: string,
  root: string | undefined
): ResolvedPaths
{
  return {
    target: realpathSync(path),
    root: root === undefined ? null : realpathSync(root),
  }
}

// shared by the read & write opens below
async function openCheckedFile(
  path: string,
  flags: number,
  options: RegularFileOpenOptions
): Promise<OpenedRegularFile>
{
  const { signal } = options
  const before = await resolvePaths(path, options.root)
  signal?.throwIfAborted()
  confinedTarget(before.target, before.root)
  const handle = await open(before.target, flags)
  try
  {
    signal?.throwIfAborted()
    const [stats, current, after] = await Promise.all([
      handle.stat(),
      lstat(before.target),
      resolvePaths(path, options.root),
    ])
    signal?.throwIfAborted()
    checkOpenedFile(before, after, stats, current)
    return { path: before.target, handle, stats }
  }
  catch (err)
  {
    await handle.close().catch(() => undefined)
    throw err
  }
}

// open a regular file by its real path w/o blocking on FIFOs; realpath runs
// before & after the no-follow open and the fd must match a fresh lstat.
// throws on any failure
export function openRegularFile(
  path: string,
  options: RegularFileOpenOptions = {}
): Promise<OpenedRegularFile>
{
  return openCheckedFile(path, REGULAR_FILE_OPEN_FLAGS, options)
}

// openRegularFile for writing an existing file in place; the caller truncates
// & writes through the handle only after these checks pass
export function openRegularFileForWrite(
  path: string,
  options: RegularFileOpenOptions = {}
): Promise<OpenedRegularFile>
{
  return openCheckedFile(path, REGULAR_FILE_WRITE_FLAGS, options)
}

// start from the fstat size so small files stay small, growing toward one
// byte past the limit if a writer extends the file mid-read
function growBuffer(buffer: Buffer, length: number, maxBytes: number): Buffer
{
  const grown = Buffer.allocUnsafe(Math.min(maxBytes + 1, buffer.length * 2))
  buffer.copy(grown, 0, 0, length)
  return grown
}

function boundedResult(
  buffer: Buffer,
  length: number,
  maxBytes: number
): BoundedBytes
{
  return {
    bytes: buffer.subarray(0, Math.min(length, maxBytes)),
    truncated: length > maxBytes,
  }
}

// truncate & rewrite a file from openRegularFileForWrite, then close it
export async function replaceOpenedFile(
  file: OpenedRegularFile,
  content: string,
  signal?: AbortSignal
): Promise<void>
{
  try
  {
    await file.handle.truncate(0)
    await file.handle.writeFile(content, { encoding: 'utf-8', signal })
  }
  finally
  {
    await file.handle.close()
  }
}

// replace an existing file in place through its re-checked real path, so a
// link or dir swapped in after an earlier read fails instead of being followed
export async function overwriteRegularFile(
  path: string,
  content: string,
  options: RegularFileOpenOptions = {}
): Promise<void>
{
  const file = await openRegularFileForWrite(path, options)
  await replaceOpenedFile(file, content, options.signal)
}

// read at most maxBytes from an opened regular file, flagging overflow
export async function readOpenedFile(
  file: OpenedRegularFile,
  maxBytes: number,
  signal?: AbortSignal
): Promise<BoundedBytes>
{
  let buffer: Buffer = Buffer.allocUnsafe(
    Math.min(maxBytes, file.stats.size) + 1
  )
  let length = 0
  while (true)
  {
    if (length === buffer.length)
    {
      if (length > maxBytes) break
      buffer = growBuffer(buffer, length, maxBytes)
    }
    const { bytesRead } = await file.handle.read(
      buffer,
      length,
      buffer.length - length,
      length
    )
    signal?.throwIfAborted()
    if (bytesRead === 0) break
    length += bytesRead
  }
  return boundedResult(buffer, length, maxBytes)
}

// sync openRegularFile + readOpenedFile for prompt assembly, w/ the same
// real-path, no-follow, regular-file & inode checks; throws on any failure.
// `path` is the real path the bytes were read from
export function readRegularFileSync(
  path: string,
  maxBytes: number,
  root?: string
): BoundedBytes & { path: string }
{
  const before = resolvePathsSync(path, root)
  confinedTarget(before.target, before.root)
  const descriptor = openSync(before.target, REGULAR_FILE_OPEN_FLAGS)
  try
  {
    const stats = fstatSync(descriptor)
    checkOpenedFile(
      before,
      resolvePathsSync(path, root),
      stats,
      lstatSync(before.target)
    )
    let buffer: Buffer = Buffer.allocUnsafe(Math.min(maxBytes, stats.size) + 1)
    let length = 0
    while (true)
    {
      if (length === buffer.length)
      {
        if (length > maxBytes) break
        buffer = growBuffer(buffer, length, maxBytes)
      }
      const count = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        length
      )
      if (count === 0) break
      length += count
    }
    return { path: before.target, ...boundedResult(buffer, length, maxBytes) }
  }
  finally
  {
    closeSync(descriptor)
  }
}

function isMissing(err: unknown): boolean
{
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
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

function unreadableFailure(path: string, err: unknown): TextFileReadFailure
{
  return {
    ok: false,
    path,
    reason: isMissing(err) ? 'missing' : 'unreadable',
    message: `Failed to read ${path}: ${toErrorMessage(err)}`,
  }
}

// a BOM is valid UTF-8 and stays in the text so writes keep it
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function decodeText(path: string, bytes: Buffer): TextFileReadSuccess
{
  try
  {
    return {
      ok: true,
      path,
      content: STRICT_UTF8.decode(bytes),
      existed: true,
    }
  }
  catch
  {
    return {
      ok: true,
      path,
      content: bytes.toString('utf8'),
      existed: true,
      lossy: true,
    }
  }
}

async function readTextFile(
  rawPath: string,
  missingAsEmpty: boolean,
  options: TextFileReadOptions = {}
): Promise<TextFileReadResult>
{
  const path = resolvePath(rawPath, options.cwd)
  const { signal } = options
  signal?.throwIfAborted()
  let file: OpenedRegularFile | undefined
  try
  {
    file = await openRegularFile(path, { root: options.root, signal })
    if (file.stats.size > TEXT_FILE_READ_LIMIT_BYTES)
    {
      return oversizedFailure(path, file.stats.size)
    }
    const read = await readOpenedFile(file, TEXT_FILE_READ_LIMIT_BYTES, signal)
    if (read.truncated)
    {
      return oversizedFailure(path, TEXT_FILE_READ_LIMIT_BYTES + 1)
    }
    return decodeText(path, read.bytes)
  }
  catch (err)
  {
    signal?.throwIfAborted()
    if (missingAsEmpty && isMissing(err))
    {
      return { ok: true, path, content: '', existed: false }
    }
    return unreadableFailure(path, err)
  }
  finally
  {
    await file?.handle.close().catch(() => undefined)
  }
}

// one-line lead for lossy text shown to the model, so it knows the U+FFFD
// marks are not in the file & the write tools will refuse it
export function formatNotUtf8Notice(path: string): string
{
  return (
    `Note: ${path} is not valid UTF-8; invalid bytes are shown as U+FFFD, ` +
    `and edit_file & write_file will refuse to change it.\n`
  )
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
