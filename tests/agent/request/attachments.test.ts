// tests/agent/request/attachments.test.ts
// tests for atomic workspace attachment capture & exact-budget rendering

import { strict as assert } from 'node:assert'
import { symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import {
  ATTACHMENT_CONTEXT_HEADING,
  MAX_ATTACHMENT_FILES,
  MAX_RETAINED_ATTACHMENT_OVERFLOW_REPORTS,
  appendAttachmentContext,
  attachmentCaptureByteLimit,
  captureAttachments,
  materializeAttachments,
  materializeAttachmentsToFit,
  type AttachmentCapture,
  type AttachmentReader,
} from '../../../src/agent/request/attachments.js'
import { estimateModelRequestMessageDeltaTokens } from '../../../src/agent/request/projection.js'
import type { TextFileReadResult } from '../../../src/utils/file-read.js'
import { makeTempDirPool } from '../../helpers/temp.js'

const { tempDir } = makeTempDirPool()

function successfulRead(path: string, content: string): TextFileReadResult
{
  return { ok: true, path, content, existed: true }
}

test('captureAttachments applies workspace & file policy before rendering', async () =>
{
  const cwd = await tempDir('coral-attachments-policy-')
  const outside = await tempDir('coral-attachments-outside-')
  const outsideFile = join(outside, 'secret.txt')
  await writeFile(outsideFile, 'secret\n', 'utf-8')

  const readPaths: string[] = []
  const read: AttachmentReader = async (path) =>
  {
    readPaths.push(path)
    switch (basename(path))
    {
      case 'a.ts':
        return successfulRead(path, 'export const a = 1')
      case 'big.ts':
        return {
          ok: false,
          path,
          reason: 'oversized',
          message: 'too big',
        }
      case 'gone.ts':
        return {
          ok: false,
          path,
          reason: 'missing',
          message: 'gone',
        }
      case 'bin.dat':
        return successfulRead(path, `binary${String.fromCharCode(0)}blob`)
      case 'broken.ts':
        throw new Error('permission denied')
      default:
        throw new Error(`unexpected read: ${path}`)
    }
  }

  const capture = await captureAttachments(
    ['a.ts', 'big.ts', 'gone.ts', 'bin.dat', 'broken.ts', outsideFile, 'a.ts'],
    { cwd, read }
  )
  const rendered = materializeAttachments(capture, 10_000)

  assert.deepEqual(
    capture.entries.map((entry) => [
      entry.path,
      entry.status,
      entry.status === 'skipped' ? entry.reason : null,
    ]),
    [
      ['a.ts', 'captured', null],
      ['big.ts', 'skipped', 'too large'],
      ['gone.ts', 'skipped', 'not found'],
      ['bin.dat', 'skipped', 'binary'],
      ['broken.ts', 'skipped', 'unreadable'],
      [outsideFile, 'skipped', 'outside workspace'],
    ]
  )
  assert.equal(
    readPaths.some((path) => path === outsideFile),
    false
  )
  assert.equal(readPaths.filter((path) => basename(path) === 'a.ts').length, 1)
  assert.match(rendered.context ?? '', /===== a\.ts =====/)
  assert.match(rendered.context ?? '', /export const a = 1/)
  assert.doesNotMatch(rendered.context ?? '', /secret/)
  assert.deepEqual(
    rendered.skipped.map(({ path, reason }) => [path, reason]),
    [
      ['big.ts', 'too large'],
      ['gone.ts', 'not found'],
      ['bin.dat', 'binary'],
      ['broken.ts', 'unreadable'],
      [outsideFile, 'outside workspace'],
    ]
  )
})

test('captureAttachments aborts atomically & captured bytes stay durable', async () =>
{
  const cwd = await tempDir('coral-attachments-atomic-')
  const controller = new AbortController()
  let secondReadStarted!: () => void
  const secondRead = new Promise<void>((resolve) =>
  {
    secondReadStarted = resolve
  })
  let returnedCapture: AttachmentCapture | undefined

  const read: AttachmentReader = async (path, options) =>
  {
    if (basename(path) === 'first.txt')
    {
      return successfulRead(path, 'first captured bytes')
    }

    secondReadStarted()
    return await new Promise<TextFileReadResult>((_resolve, reject) =>
    {
      const rejectAbort = () =>
        reject(
          options?.signal?.reason ?? new DOMException('Aborted', 'AbortError')
        )
      if (options?.signal?.aborted) rejectAbort()
      else
        options?.signal?.addEventListener('abort', rejectAbort, { once: true })
    })
  }

  const pending = captureAttachments(['first.txt', 'second.txt'], {
    cwd,
    read,
    signal: controller.signal,
  }).then((capture) =>
  {
    returnedCapture = capture
    return capture
  })

  await secondRead
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(returnedCapture, undefined)

  const durablePath = join(cwd, 'durable.txt')
  await writeFile(durablePath, 'original captured bytes\n', 'utf-8')
  const durable = await captureAttachments(['durable.txt'], { cwd })
  await writeFile(durablePath, 'mutated bytes\n', 'utf-8')
  await unlink(durablePath)

  const rendered = materializeAttachments(durable, 10_000)
  assert.equal(Object.isFrozen(durable), true)
  assert.equal(Object.isFrozen(durable.entries), true)
  assert.equal(Object.isFrozen(durable.entries[0]!), true)
  assert.match(rendered.context ?? '', /original captured bytes/)
  assert.doesNotMatch(rendered.context ?? '', /mutated bytes/)
})

test('captureAttachments bounds canonical files, overflow reports, & aggregate reads', async () =>
{
  const cwd = await tempDir('coral-attachments-bounded-')
  const target = join(cwd, 'target.txt')
  const alias = join(cwd, 'alias.txt')
  await writeFile(target, 'target bytes\n', 'utf-8')
  await symlink(target, alias)

  const extraCount =
    MAX_ATTACHMENT_FILES + MAX_RETAINED_ATTACHMENT_OVERFLOW_REPORTS + 5
  const requested = [
    'target.txt',
    './target.txt',
    'nested/../target.txt',
    'alias.txt',
    ...Array.from({ length: extraCount }, (_, index) => `file-${index}.txt`),
  ]
  const readPaths: string[] = []
  const capture = await captureAttachments(requested, {
    cwd,
    read: async (path) =>
    {
      readPaths.push(path)
      return successfulRead(path, 'x')
    },
  })

  // the symlink alias consumes one of the bounded policy inspections but is
  // canonicalized before reading, so it cannot duplicate retained bytes
  assert.equal(readPaths.length, MAX_ATTACHMENT_FILES - 1)
  assert.equal(
    readPaths.filter((path) => basename(path) === 'target.txt').length,
    1
  )
  assert.equal(
    readPaths.some((path) => basename(path) === 'file-63.txt'),
    false
  )
  assert.equal(
    capture.entries.filter((entry) => entry.status === 'captured').length,
    MAX_ATTACHMENT_FILES - 1
  )
  assert.equal(
    capture.entries.filter(
      (entry) => entry.status === 'skipped' && entry.reason === 'over budget'
    ).length,
    MAX_RETAINED_ATTACHMENT_OVERFLOW_REPORTS
  )
  assert.equal(capture.omittedOverBudget, 7)

  const aggregateReads: string[] = []
  const retainedLimit = attachmentCaptureByteLimit(1)
  const aggregate = await captureAttachments(
    ['large.txt', 'tiny.txt', 'must-not-read.txt'],
    {
      cwd,
      renderedCharAllowance: 1,
      read: async (path) =>
      {
        aggregateReads.push(path)
        return successfulRead(
          path,
          basename(path) === 'large.txt'
            ? 'a'.repeat(retainedLimit - 4)
            : 'tiny'
        )
      },
    }
  )

  assert.deepEqual(
    aggregateReads.map((path) => basename(path)),
    ['large.txt', 'tiny.txt']
  )
  assert.deepEqual(
    aggregate.entries.map((entry) => [
      entry.path,
      entry.status,
      entry.status === 'skipped' ? entry.reason : null,
    ]),
    [
      ['large.txt', 'captured', null],
      ['tiny.txt', 'captured', null],
      ['must-not-read.txt', 'skipped', 'over budget'],
    ]
  )

  let zeroAllowanceReads = 0
  const zeroAllowance = await captureAttachments(['zero.txt'], {
    cwd,
    renderedCharAllowance: 0,
    read: async (path) =>
    {
      zeroAllowanceReads++
      return successfulRead(path, 'unreachable')
    },
  })
  assert.equal(attachmentCaptureByteLimit(0), 0)
  assert.equal(zeroAllowanceReads, 0)
  assert.deepEqual(
    zeroAllowance.entries.map((entry) =>
      entry.status === 'skipped' ? entry.reason : entry.status
    ),
    ['over budget']
  )
})

test('materializeAttachments counts every rendered character in one shared budget', async () =>
{
  const cwd = await tempDir('coral-attachments-budget-')
  const contents: Record<string, string> = {
    'first.txt': 'tiny',
    'second.txt': `${'a'.repeat(129)}\n${'b'.repeat(130)}\n${'c'.repeat(200)}`,
    'third.txt': 'later',
  }
  const read: AttachmentReader = async (path) =>
    successfulRead(path, contents[basename(path)]!)
  const capture = await captureAttachments(
    ['first.txt', 'second.txt', 'third.txt'],
    { cwd, read }
  )
  const expected = `${ATTACHMENT_CONTEXT_HEADING}\n\n===== first.txt =====\ntiny\n\n===== second.txt (truncated) =====\n${'a'.repeat(129)}\n${'b'.repeat(130)}`

  // one extra character reaches the second line boundary; nothing remains for
  // the later mention, so earlier files retain priority across the shared cap
  const rendered = materializeAttachments(capture, expected.length + 1)
  assert.equal(rendered.context, expected)
  assert.equal(rendered.usedChars, expected.length)
  assert.ok(rendered.usedChars <= expected.length + 1)
  assert.deepEqual(rendered.attached, [
    { path: 'first.txt', truncated: false },
    { path: 'second.txt', truncated: true },
  ])
  assert.deepEqual(
    rendered.skipped.map(({ path, reason }) => ({ path, reason })),
    [{ path: 'third.txt', reason: 'over budget' }]
  )

  // removing that one character backs off to a sub-minimum first line, so the
  // second attachment is skipped rather than emitting a misleading fragment;
  // the later tiny file can still use space the large file could not
  const tighter = materializeAttachments(capture, expected.length)
  assert.deepEqual(tighter.attached, [
    { path: 'first.txt', truncated: false },
    { path: 'third.txt', truncated: false },
  ])
  assert.deepEqual(
    tighter.skipped.map(({ path, reason }) => ({ path, reason })),
    [{ path: 'second.txt', reason: 'over budget' }]
  )
})

test('exact attachment fitting avoids global non-monotonic search & preserves Unicode', () =>
{
  const cleanContent = 'inspect these files'
  const baseMessage = { role: 'user' as const, content: cleanContent }
  const capture: AttachmentCapture = {
    entries: [
      {
        status: 'captured',
        path: `${'a'.repeat(72)}.txt`,
        resolvedPath: '/workspace/ascii.txt',
        content: 'a'.repeat(900),
      },
      {
        status: 'captured',
        path: 'e.txt',
        resolvedPath: '/workspace/emoji.txt',
        content: '🙂'.repeat(300),
      },
    ],
  }
  const tokenDelta = (context: string | null) =>
    estimateModelRequestMessageDeltaTokens(baseMessage, {
      role: 'user',
      content: appendAttachmentContext(cleanContent, context),
    })

  // global character caps are not a valid exact-token search axis: crossing
  // this structural boundary replaces an emoji truncation w/ ASCII content
  const beforeBoundary = tokenDelta(
    materializeAttachments(capture, 393).context
  )
  const afterBoundary = tokenDelta(materializeAttachments(capture, 394).context)
  assert.ok(afterBoundary < beforeBoundary)

  const tokenLimit = afterBoundary
  const rendered = materializeAttachmentsToFit(
    capture,
    1_200,
    (context) => tokenDelta(context) <= tokenLimit
  )

  assert.ok(tokenDelta(rendered.context) <= tokenLimit)
  assert.equal(rendered.attached[0]?.path, `${'a'.repeat(72)}.txt`)
  assert.equal(
    rendered.context?.includes('\uFFFD') ?? false,
    false,
    'valid astral input must never materialize as replacement characters'
  )
  assert.equal(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      rendered.context ?? ''
    ),
    false,
    'materialized context must not contain lone surrogate code units'
  )

  const emojiOnly: AttachmentCapture = { entries: [capture.entries[1]!] }
  const emoji = materializeAttachmentsToFit(emojiOnly, 401, () => true)
  assert.deepEqual(emoji.attached, [{ path: 'e.txt', truncated: true }])
  assert.equal(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      emoji.context ?? ''
    ),
    false
  )

  const laterSmallCapture: AttachmentCapture = {
    entries: [
      {
        status: 'captured',
        path: 'large.txt',
        resolvedPath: '/workspace/large.txt',
        content: 'a'.repeat(900),
      },
      {
        status: 'captured',
        path: 'tiny.txt',
        resolvedPath: '/workspace/tiny.txt',
        content: 'ok',
      },
    ],
  }
  const tinyContext = `${ATTACHMENT_CONTEXT_HEADING}\n\n===== tiny.txt =====\nok`
  const tinyLimit = tokenDelta(tinyContext)
  const laterSmall = materializeAttachmentsToFit(
    laterSmallCapture,
    1_200,
    (context) => tokenDelta(context) <= tinyLimit
  )
  assert.deepEqual(laterSmall.attached, [
    { path: 'tiny.txt', truncated: false },
  ])
  assert.deepEqual(
    laterSmall.skipped.map(({ path, reason }) => ({ path, reason })),
    [{ path: 'large.txt', reason: 'over budget' }]
  )
})
