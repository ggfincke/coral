// tests/agent/request/turn-attachments.test.ts
// attachment capture units and accepted-turn budget wiring

import { strict as assert } from 'node:assert'
import { symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, test } from 'node:test'
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
  type AttachmentMaterialization,
  type AttachmentReader,
} from '../../../src/agent/request/attachments.js'
import {
  requestBudgetCapacity,
  RequestBudgetError,
} from '../../../src/agent/request/budget.js'
import {
  estimateModelRequestMessageDeltaTokens,
  estimateModelRequestMessagesTokens,
  estimateModelRequestToolTokens,
  estimateRequestFramingTokens,
} from '../../../src/agent/request/projection.js'
import { estimateMessageTokens } from '../../../src/agent/state/compaction.js'
import { MIN_NUM_CTX } from '../../../src/config/context.js'
import type { Tool } from '../../../src/tools/tool.js'
import type {
  ChatRequest,
  OllamaMessage,
} from '../../../src/types/inference.js'
import {
  readRequiredTextFile,
  type TextFileReadResult,
} from '../../../src/utils/file-read.js'
import { makeAgentEvents, makeFakeAgent } from '../../helpers/agent-harness.js'
import { makeTempDirPool } from '../../helpers/temp.js'

describe('attachments', () =>
{
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
})

describe('turn-context', () =>
{
  const { tempDir } = makeTempDirPool()

  interface Deferred<T>
  {
    promise: Promise<T>
    resolve: (value: T) => void
  }

  function deferred<T>(): Deferred<T>
  {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) =>
    {
      resolve = done
    })
    return { promise, resolve }
  }

  function successfulRead(path: string, content: string): TextFileReadResult
  {
    return { ok: true, path, content, existed: true }
  }

  function abortError(signal?: AbortSignal): unknown
  {
    return signal?.reason ?? new DOMException('Aborted', 'AbortError')
  }

  const doneChunk = {
    message: { role: 'assistant' as const, content: 'done' },
    done: true,
  }

  test('accepted turns stay clean when attachment capture or Git gathering aborts', async () =>
  {
    for (const phase of ['attachment', 'git'] as const)
    {
      const cwd = await tempDir(`coral-turn-${phase}-abort-`)
      const phaseStarted = deferred<void>()
      const controller = new AbortController()
      let attachmentReads = 0
      let gitCalls = 0

      const read: AttachmentReader = async (path, options) =>
      {
        attachmentReads += 1
        if (phase === 'attachment' && basename(path) === 'second.txt')
        {
          phaseStarted.resolve()
          return await new Promise<TextFileReadResult>((_resolve, reject) =>
          {
            const rejectAbort = () => reject(abortError(options?.signal))
            if (options?.signal?.aborted) rejectAbort()
            else
            {
              options?.signal?.addEventListener('abort', rejectAbort, {
                once: true,
              })
            }
          })
        }

        return successfulRead(path, `captured-${basename(path)}`)
      }

      const { agent, streams } = makeFakeAgent(cwd, [[doneChunk]], {
        numCtx: 8_192,
        tools: [],
        turnContext: {
          attachmentReader: read,
          async buildGitContext(_requestedCwd, signal)
          {
            gitCalls += 1
            if (phase !== 'git') return null

            phaseStarted.resolve()
            await new Promise<void>((resolve) =>
            {
              const resolveAbort = () => resolve()
              if (signal?.aborted) resolveAbort()
              else
              {
                signal?.addEventListener('abort', resolveAbort, { once: true })
              }
            })
            return {
              role: 'system',
              content: '## Git Context\n- status: stale-after-abort',
            }
          },
        },
      })

      const priorMessages: OllamaMessage[] =
        phase === 'git'
          ? Array.from({ length: 10 }, (_unused, index) => ({
              role: 'tool' as const,
              tool_name: `old_tool_${index}`,
              content: `old-${index}-${'x'.repeat(3_000)}`,
            }))
          : [
              { role: 'user', content: 'prior question' },
              { role: 'assistant', content: 'prior answer' },
            ]
      agent.restoreMessages(priorMessages)
      const priorSnapshot = structuredClone(agent.getMessages())
      const priorEstimate = agent.getEstimatedTokens()
      const cleanContent = `inspect @first.txt @second.txt during ${phase}`
      const accepted = agent.acceptTurn({
        content: cleanContent,
        attachmentPaths: ['first.txt', 'second.txt'],
      })

      assert.deepEqual(agent.getMessages().at(-1), {
        role: 'user',
        content: cleanContent,
        displayContent: cleanContent,
      })
      assert.equal(
        agent.getEstimatedTokens(),
        priorEstimate +
          estimateMessageTokens({ role: 'user', content: cleanContent })
      )

      const run = agent.runAcceptedTurn(
        accepted,
        makeAgentEvents(),
        controller.signal
      )
      await phaseStarted.promise

      // attachment bytes may exist in the assembler, but not in conversation
      assert.deepEqual(agent.getMessages().at(-1), {
        role: 'user',
        content: cleanContent,
        displayContent: cleanContent,
      })
      controller.abort()
      await run

      const after = agent.getMessages()
      assert.deepEqual(after.slice(0, -1), priorSnapshot)
      assert.deepEqual(after.at(-1), {
        role: 'user',
        content: cleanContent,
        displayContent: cleanContent,
      })
      assert.doesNotMatch(JSON.stringify(after), /captured-(first|second)/)
      assert.equal(streams(), 0)
      assert.equal(agent.getLastRequestBudget(), undefined)
      assert.equal(attachmentReads, 2)
      assert.equal(gitCalls, phase === 'git' ? 1 : 0)
    }
  })

  test('captured attachment bytes commit atomically & survive later turns and restore', async () =>
  {
    const cwd = await tempDir('coral-turn-capture-durable-')
    const firstPath = join(cwd, 'first.txt')
    const secondPath = join(cwd, 'second.txt')
    const originalFirst = 'ORIGINAL-FIRST\r\nΩ\n'
    const originalSecond = 'ORIGINAL-SECOND\nexact bytes\n'
    await writeFile(firstPath, originalFirst, 'utf-8')
    await writeFile(secondPath, originalSecond, 'utf-8')

    const secondReadStarted = deferred<void>()
    const releaseSecondRead = deferred<void>()
    const gitStarted = deferred<void>()
    const releaseGit = deferred<void>()
    const requests: ChatRequest[] = []
    let readCount = 0
    let gitCalls = 0

    const read: AttachmentReader = async (path, options) =>
    {
      readCount += 1
      if (basename(path) === 'second.txt')
      {
        secondReadStarted.resolve()
        await releaseSecondRead.promise
      }
      return readRequiredTextFile(path, options)
    }

    const { agent, streams } = makeFakeAgent(
      cwd,
      async function* (request)
      {
        if (!request) throw new Error('missing request')
        requests.push(structuredClone(request))
        yield doneChunk
      },
      {
        numCtx: 8_192,
        tools: [],
        turnContext: {
          attachmentReader: read,
          async buildGitContext()
          {
            gitCalls += 1
            if (gitCalls === 1)
            {
              gitStarted.resolve()
              await releaseGit.promise
            }
            return null
          },
        },
      }
    )

    const cleanContent = 'compare @first.txt and @second.txt'
    const accepted = agent.acceptTurn({
      content: cleanContent,
      attachmentPaths: ['first.txt', 'second.txt'],
    })
    const run = agent.runAcceptedTurn(accepted, makeAgentEvents())

    await secondReadStarted.promise
    assert.equal(streams(), 0)
    assert.equal(agent.getMessages().at(-1)?.content, cleanContent)
    releaseSecondRead.resolve()

    await gitStarted.promise
    assert.equal(streams(), 0)
    assert.equal(agent.getMessages().at(-1)?.content, cleanContent)

    // mutate the sources after capture but before the one synchronous commit
    await writeFile(firstPath, 'MUTATED-FIRST\n', 'utf-8')
    await unlink(secondPath)
    releaseGit.resolve()
    await run

    assert.equal(streams(), 1)
    assert.equal(readCount, 2)
    const storedCapture = agent
      .getMessages()
      .find((message) => message.displayContent === cleanContent)
    assert.ok(storedCapture)
    assert.match(storedCapture.content, /ORIGINAL-FIRST\r\nΩ\n/)
    assert.match(storedCapture.content, /ORIGINAL-SECOND\nexact bytes\n/)
    assert.doesNotMatch(storedCapture.content, /MUTATED-FIRST/)
    assert.deepEqual(Object.keys(storedCapture).sort(), [
      'attachmentReport',
      'content',
      'displayContent',
      'role',
    ])
    assert.deepEqual(storedCapture.attachmentReport, {
      attached: [
        { path: 'first.txt', truncated: false },
        { path: 'second.txt', truncated: false },
      ],
      skipped: [],
    })

    await agent.run('follow up without attachments', makeAgentEvents())
    assert.equal(streams(), 2)
    assert.equal(readCount, 2)
    const secondTurnHistorical = requests[1]!.messages.find((message) =>
      message.content.includes('ORIGINAL-FIRST')
    )
    assert.ok(secondTurnHistorical)
    assert.equal(secondTurnHistorical.content, storedCapture.content)
    assert.deepEqual(Object.keys(secondTurnHistorical).sort(), [
      'content',
      'role',
    ])

    const savedMessages = structuredClone(agent.getMessages())
    let resumedReads = 0
    const resumedRequests: ChatRequest[] = []
    const { agent: resumed } = makeFakeAgent(
      cwd,
      async function* (request)
      {
        if (!request) throw new Error('missing resumed request')
        resumedRequests.push(structuredClone(request))
        yield doneChunk
      },
      {
        numCtx: 8_192,
        tools: [],
        turnContext: {
          async attachmentReader()
          {
            resumedReads += 1
            throw new Error('historical attachment was re-read')
          },
          async buildGitContext()
          {
            return null
          },
        },
      }
    )
    resumed.restoreMessages(savedMessages)
    await resumed.run('continue after restore', makeAgentEvents())

    assert.equal(resumedReads, 0)
    const resumedHistorical = resumedRequests[0]!.messages.find((message) =>
      message.content.includes('ORIGINAL-FIRST')
    )
    assert.ok(resumedHistorical)
    assert.equal(resumedHistorical.content, storedCapture.content)
    assert.doesNotMatch(resumedHistorical.content, /MUTATED-FIRST/)
    assert.deepEqual(
      resumed
        .getMessages()
        .find((message) => message.displayContent === cleanContent)
        ?.attachmentReport,
      storedCapture.attachmentReport
    )
  })

  test('an 8K request accounts every source & fixed-cost overflow fails cleanly', async () =>
  {
    const cwd = await tempDir('coral-turn-budget-')
    const requests: ChatRequest[] = []
    let attachmentResult: AttachmentMaterialization | undefined

    const fixtureTools: Tool[] = [
      {
        name: 'inspect_fixture',
        description: 'inspect one deterministic fixture value',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'fixture-relative path' },
          },
          required: ['path'],
        },
        async execute()
        {
          return { output: 'unused' }
        },
      },
      {
        name: 'lookup_fixture',
        description: 'look up one deterministic fixture symbol',
        parameters: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'exact symbol name' },
          },
          required: ['symbol'],
        },
        async execute()
        {
          return { output: 'unused' }
        },
      },
    ]
    const attachmentBodies: Record<string, string> = {
      'first.txt': 'FIRST-EXACT\n',
      'second.txt': Array.from(
        { length: 2_000 },
        (_unused, index) =>
          `SECOND-${String(index).padStart(4, '0')}-${'s'.repeat(20)}`
      ).join('\n'),
      'third.txt': Array.from(
        { length: 2_000 },
        (_unused, index) =>
          `THIRD-${String(index).padStart(4, '0')}-${'t'.repeat(20)}`
      ).join('\n'),
    }
    const read: AttachmentReader = async (path) =>
      successfulRead(path, attachmentBodies[basename(path)]!)

    const { agent } = makeFakeAgent(
      cwd,
      async function* (request)
      {
        if (!request) throw new Error('missing budgeted request')
        requests.push(structuredClone(request))
        yield doneChunk
      },
      {
        numCtx: 8_192,
        tools: fixtureTools,
        turnContext: {
          attachmentReader: read,
          async buildGitContext()
          {
            return {
              role: 'system',
              content:
                `## Git Context\n- branch: fixture\n- status: dirty\n` +
                `- detail: ${'g'.repeat(320)}`,
            }
          },
        },
      }
    )

    await agent.run(
      {
        content: 'inspect @first.txt @second.txt @third.txt',
        attachmentPaths: ['first.txt', 'second.txt', 'third.txt'],
      },
      makeAgentEvents({
        onAttachments(result)
        {
          attachmentResult = result
        },
      })
    )

    assert.equal(requests.length, 1)
    const request = requests[0]!
    const budget = agent.getLastRequestBudget()
    assert.ok(budget)
    const categoryTotal = Object.values(budget.categories).reduce(
      (total, tokens) => total + tokens,
      0
    )
    const actualPromptTokens =
      estimateModelRequestMessagesTokens(request.messages) +
      estimateModelRequestToolTokens(request.tools ?? []) +
      estimateRequestFramingTokens(request.messages.length)

    assert.equal(categoryTotal, budget.promptTokens)
    assert.equal(actualPromptTokens, budget.promptTokens)
    assert.equal(actualPromptTokens + budget.responseReserve, budget.totalTokens)
    assert.equal(budget.responseReserve, 1_024)
    assert.equal(request.num_ctx, 8_192)
    assert.equal(request.num_predict, budget.responseReserve)
    assert.equal(budget.fits, true)
    assert.ok(budget.totalTokens <= 8_192)
    assert.equal(
      budget.categories.toolDefinitions,
      estimateModelRequestToolTokens(request.tools ?? [])
    )
    assert.ok(budget.categories.gitContext > 0)
    assert.deepEqual(attachmentResult?.attached, [
      { path: 'first.txt', truncated: false },
      { path: 'second.txt', truncated: true },
    ])
    assert.deepEqual(
      attachmentResult?.skipped.map(({ path, reason }) => ({ path, reason })),
      [{ path: 'third.txt', reason: 'over budget' }]
    )
    const requestUser = request.messages.find((message) =>
      message.content.startsWith('inspect @first.txt')
    )
    assert.ok(requestUser)
    assert.match(requestUser.content, /FIRST-EXACT/)
    assert.match(requestUser.content, /SECOND-0000/)
    assert.doesNotMatch(requestUser.content, /THIRD-0000/)

    const enormousTool: Tool = {
      name: 'enormous_fixture',
      description: 'd'.repeat(80_000),
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 's'.repeat(80_000) },
        },
      },
      async execute()
      {
        return { output: 'unused' }
      },
    }
    let overflowReads = 0
    let overflowError: Error | undefined
    let overflowDone = 0
    const overflow = makeFakeAgent(cwd, [[doneChunk]], {
      numCtx: 8_192,
      tools: [enormousTool],
      turnContext: {
        async attachmentReader(path)
        {
          overflowReads += 1
          return successfulRead(path, 'must not be read')
        },
        async buildGitContext()
        {
          return null
        },
      },
    })
    const cleanOverflow = 'clean fixed-cost overflow @never.txt'
    const accepted = overflow.agent.acceptTurn({
      content: cleanOverflow,
      attachmentPaths: ['never.txt'],
    })
    await overflow.agent.runAcceptedTurn(
      accepted,
      makeAgentEvents({
        onDone()
        {
          overflowDone += 1
        },
        onError(error)
        {
          overflowError = error
        },
      })
    )

    assert.ok(overflowError instanceof RequestBudgetError)
    assert.equal(overflowError.code, 'fixed_cost_overflow')
    assert.equal(overflow.streams(), 0)
    assert.equal(overflowReads, 0)
    assert.equal(overflowDone, 0)
    assert.deepEqual(overflow.agent.getMessages().at(-1), {
      role: 'user',
      content: cleanOverflow,
      displayContent: cleanOverflow,
    })
    const overflowBudget = overflow.agent.getLastRequestBudget()
    assert.ok(overflowBudget)
    assert.equal(overflowBudget.fits, false)
    assert.ok(overflowBudget.fixedPromptTokens > overflowBudget.promptLimit)
  })

  test('parallel ASCII and emoji tool results share one exact continuation budget', async () =>
  {
    const cwd = await tempDir('coral-turn-tool-result-budget-')
    const requests: ChatRequest[] = []
    let activeTools = 0
    let maxActiveTools = 0

    function largeOutput(label: string, body: string): string
    {
      const lines = Array.from(
        { length: 4_000 },
        (_unused, index) => `${label}-${index}-${body.repeat(32)}`
      )
      lines.splice(2_000, 0, '[redacted]')
      return [`${label}_HEAD`, ...lines, `${label}_TAIL`].join('\n')
    }

    function outputTool(name: string, output: string): Tool
    {
      return {
        name,
        description: `return the ${name} fixture`,
        parameters: { type: 'object', properties: {} },
        parallelSafe: true,
        async execute()
        {
          activeTools += 1
          maxActiveTools = Math.max(maxActiveTools, activeTools)
          await new Promise((resolve) => setTimeout(resolve, 20))
          activeTools -= 1
          return { output }
        },
      }
    }

    const tools = [
      outputTool('search_code', largeOutput('ASCII', 'a')),
      outputTool('git_status', largeOutput('EMOJI', '🪸')),
    ]
    const { agent, streams } = makeFakeAgent(
      cwd,
      async function* (request)
      {
        if (!request) throw new Error('missing tool-result request')
        requests.push(structuredClone(request))
        if (requests.length === 1)
        {
          yield {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: tools.map((tool) => ({
                type: 'function' as const,
                function: { name: tool.name, arguments: {} },
              })),
            },
            done: true,
          }
          return
        }
        yield doneChunk
      },
      {
        numCtx: 8_192,
        tools,
        turnContext: {
          async buildGitContext()
          {
            return null
          },
        },
      }
    )

    await agent.run('run both large tools', makeAgentEvents())

    assert.equal(maxActiveTools, 2)
    assert.equal(streams(), 2)
    assert.equal(requests.length, 2)
    const continuation = requests[1]!
    const results = continuation.messages.filter(
      (message) => message.role === 'tool'
    )
    assert.equal(results.length, 2)
    assert.match(results[0]!.content, /ASCII_HEAD/)
    assert.match(results[0]!.content, /ASCII_TAIL/)
    assert.match(results[1]!.content, /EMOJI_HEAD/)
    assert.match(results[1]!.content, /EMOJI_TAIL/)
    for (const result of results)
    {
      assert.match(result.content, /output truncated/)
      assert.match(result.content, /redacted.*omitted output/)
      assert.equal(
        Buffer.from(result.content, 'utf-8').toString('utf-8'),
        result.content
      )
    }
    assert.ok(results[0]!.content.length > results[1]!.content.length)

    const budget = agent.getLastRequestBudget()
    assert.ok(budget)
    const actualPromptTokens =
      estimateModelRequestMessagesTokens(continuation.messages) +
      estimateModelRequestToolTokens(continuation.tools ?? []) +
      estimateRequestFramingTokens(continuation.messages.length)
    assert.equal(actualPromptTokens, budget.promptTokens)
    assert.ok(actualPromptTokens <= budget.promptLimit)
    assert.equal(budget.fits, true)
  })

  test('unresolved context metadata pins one explicit fallback for summaries and turns', async () =>
  {
    const cwd = await tempDir('coral-turn-context-fallback-')
    const requests: ChatRequest[] = []
    const { agent } = makeFakeAgent(
      cwd,
      async function* (request)
      {
        if (!request) throw new Error('missing fallback request')
        requests.push(structuredClone(request))
        yield {
          message: {
            role: 'assistant',
            content: request.tools === undefined ? 'compact summary' : 'done',
          },
          done: true,
        }
      },
      {
        tools: [],
        turnContext: {
          async buildGitContext()
          {
            return null
          },
        },
      }
    )
    agent.restoreMessages([
      { role: 'user', content: 'question one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'question two' },
      { role: 'assistant', content: 'answer two' },
      { role: 'user', content: 'question three' },
      { role: 'assistant', content: 'answer three' },
    ])

    assert.ok(await agent.forceCompact())
    await agent.run('continue after fallback compaction', makeAgentEvents())

    assert.equal(requests.length, 2)
    const [summaryRequest, normalRequest] = requests
    const capacity = requestBudgetCapacity(MIN_NUM_CTX)
    assert.equal(summaryRequest!.num_ctx, MIN_NUM_CTX)
    assert.equal(normalRequest!.num_ctx, MIN_NUM_CTX)
    assert.equal(summaryRequest!.num_predict, capacity.summaryResponseReserve)
    assert.equal(normalRequest!.num_predict, capacity.responseReserve)
    assert.equal(agent.getFrozenPrefix().contextWindow, MIN_NUM_CTX)
    assert.equal(agent.getLastRequestBudget()?.contextWindow, MIN_NUM_CTX)
  })
})
