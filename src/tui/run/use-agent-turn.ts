// src/tui/run/use-agent-turn.ts
// project Agent turn events into transcript and run presentation state

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { Agent } from '../../agent/agent.js'
import type { AcceptedTurn, AgentEvents } from '../../agent/contracts.js'
import type { SessionData } from '../../session/types.js'
import { previewToolDiff } from '../../tools/preview.js'
import { pluralize } from '../../utils/pluralize.js'
import { toErrorMessage } from '../../utils/errors.js'
import { formatMentionNotice } from '../prompt/mentions.js'
import { formatAutoCompactionResult } from '../commands/conversation-output.js'
import { computeTokensPerSecond, formatElapsed } from '../shell/metrics.js'
import type {
  InteractiveSession,
  InteractiveSessionView,
  TurnCompletion,
} from '../session/use-interactive-session.js'
import { settlementApproved } from '../session/interactive-runtime.js'
import { style } from '../theme.js'
import { buildRestoredBlocks } from '../transcript/restored-blocks.js'
import { failPendingToolCalls } from '../transcript/transcript.js'
import { capStoredOutput } from '../../utils/truncate-output.js'
import type {
  DiffBlock,
  OutputBlock,
  ToolCallBlock,
} from '../transcript/types.js'
import type { RunStage } from './run-stage.js'
import { useAnimationTimer } from './use-animation-timer.js'
import { useStreamBuffer, type StreamBuffer } from './use-stream-buffer.js'

const FLUSH_INTERVAL = 32
// silence threshold before the status line flags the stream as stalled
const STALL_WARNING_MS = 3_000

const SPINNER_INTERVAL = 80

// timer-polled stall flag: token-driven stages measure since the last chunk,
// the waiting stage since the current wait began (each tool result starts a
// new one); a blocking prompt is the user's wait, never a stall
function useStalledFlag(
  runStage: RunStage,
  lastTokenAt: number | null,
  waitStartedAt: number | null,
  promptActive: boolean
): boolean
{
  const [stalled, setStalled] = useState(false)
  // the interval reads these through a ref so a token flush or animation
  // render never restarts it (a restart every <80 ms would starve the poll)
  const latest = useRef({ lastTokenAt, waitStartedAt, promptActive })
  useEffect(() =>
  {
    latest.current = { lastTokenAt, waitStartedAt, promptActive }
  }, [lastTokenAt, waitStartedAt, promptActive])

  useEffect(() =>
  {
    const stageActive =
      runStage === 'responding' ||
      runStage === 'thinking' ||
      runStage === 'waiting'

    // polled (never set synchronously) so the flag both latches and clears
    // without cascading renders
    const timer = setInterval(() =>
    {
      const current = latest.current
      if (!stageActive || current.promptActive)
      {
        setStalled(false)
        return
      }

      const since =
        runStage === 'waiting' ? current.waitStartedAt : current.lastTokenAt
      setStalled(since !== null && Date.now() - since > STALL_WARNING_MS)
    }, SPINNER_INTERVAL)

    return () => clearInterval(timer)
  }, [runStage])

  return stalled
}

type VerificationResult = Parameters<
  NonNullable<AgentEvents['onVerification']>
>[0]

function formatVerification(result: VerificationResult): string
{
  const label = pluralize(result.editCount, 'edit')
  if (result.status === 'pass')
  {
    return `${style('success')('✓ self-check passed')} — ${label} reviewed`
  }
  if (result.status === 'fail')
  {
    const reason = result.reason ?? 'change may not match the request'
    return `${style('warning')(`⚠ self-check flagged ${label}`)}: ${reason}${
      result.retrying ? ' — asking the model to fix it' : ''
    }`
  }
  // an errored check never reviewed the edits, so it is not a verdict
  if (result.errored)
  {
    // the Agent's reason repeats the label; keep only the error text
    const detail = (result.reason ?? 'unknown error').replace(
      /^self-check failed: /,
      ''
    )
    return `${style('warning')('⚠ self-check errored')}, ${label} not reviewed: ${detail}`
  }
  return `self-check inconclusive — ${label} reviewed`
}

// a refused snapshot (one that would not load back) says so once; later
// failures keep the generic line
function persistenceBlocks(completion: TurnCompletion): OutputBlock[]
{
  if (completion.persistence !== 'error') return []
  return [
    {
      type: 'error',
      content: completion.saveRefused
        ? 'Session save refused: the conversation would not load back from disk, so the last good save is kept.'
        : 'Session save failed; this turn may not be available after exit.',
    },
  ]
}

export interface TokenUsageView
{
  prompt: number
  completion: number
  context: number
  contextEstimated: boolean
  lastPrefillTps: number
  lastDecodeTps: number
}

const EMPTY_TOKEN_USAGE: TokenUsageView = {
  prompt: 0,
  completion: 0,
  context: 0,
  contextEstimated: true,
  lastPrefillTps: 0,
  lastDecodeTps: 0,
}

export interface UseAgentTurnOptions
{
  initialSession: SessionData | null
  session: InteractiveSession
  addHistoryEntry: (text: string, sessionId: string | null) => void
  clearInput: () => void
  scrollToLatest: () => void
  onInterrupted: () => void
}

export interface RunAgentTurnOptions
{
  historyRecorded: boolean
  attachmentPaths: string[]
  // autosends leave a newer unsubmitted composer draft intact
  preserveInput?: boolean
  displayContent?: string
}

export interface AgentTurnController
{
  output: OutputBlock[]
  setOutput: Dispatch<SetStateAction<OutputBlock[]>>
  runStage: RunStage
  runElapsed: string | null
  tokenUsage: TokenUsageView
  streamBuffer: StreamBuffer
  spinnerTick: number
  waitingElapsed: number
  showWaitingIndicator: boolean
  // bumps whenever the whole transcript is replaced (resume, clear, rebuild)
  transcriptEpoch: number
  view: InteractiveSessionView
  rebuildTranscript: (agent?: Agent | null) => void
  run: (value: string, options: RunAgentTurnOptions) => Promise<void>
  isRunning: boolean
  // true while tokens have stopped flowing past the stall threshold
  stalled: boolean
}

// a failed call keeps its output too (a failing command's stdout); the model
// saw it, so the user should be able to as well
export function failedToolResultText(error: string, result: string): string
{
  return result ? `${error}\n${capStoredOutput(result).text}` : error
}

export function useAgentTurn(
  options: UseAgentTurnOptions
): AgentTurnController
{
  const {
    initialSession,
    session,
    addHistoryEntry,
    clearInput,
    scrollToLatest,
    onInterrupted,
  } = options
  const {
    agent,
    activePrompt,
    acceptsEvent,
    beginOperation,
    completeTurn,
    getSessionId,
    isYolo,
    requestPrompt,
    requestToolApproval,
    runOperation,
  } = session
  const [output, setOutput] = useState<OutputBlock[]>(() =>
    initialSession
      ? buildRestoredBlocks(initialSession.messages, initialSession.undo)
      : []
  )
  const [runStage, setRunStage] = useState<RunStage>('idle')
  const [transcriptEpoch, setTranscriptEpoch] = useState(0)
  const [waitStartedAt, setWaitStartedAt] = useState<number | null>(null)
  // read by prompt callbacks that resolve after the render that opened them
  const runStageRef = useRef<RunStage>(runStage)
  useEffect(() =>
  {
    runStageRef.current = runStage
  }, [runStage])
  const [runElapsed, setRunElapsed] = useState<string | null>(null)
  const [tokenUsage, setTokenUsage] = useState(() => ({
    ...EMPTY_TOKEN_USAGE,
    context: agent?.getEstimatedTokens() ?? 0,
  }))
  const runStartTimeRef = useRef<number | null>(null)
  const toolStartTimesRef = useRef<Map<number, number>>(new Map())
  const {
    streamBuf,
    appendText,
    appendThinking,
    consumeBufferedBlocks,
    resetStreamBuffer,
  } = useStreamBuffer(FLUSH_INTERVAL)
  const {
    spinnerTick,
    waitingElapsed,
    showWaitingIndicator,
    startWaiting,
    stopWaiting,
    resetAnimation,
  } = useAnimationTimer(runStage, SPINNER_INTERVAL)

  // each entry into the waiting stage restarts both the shimmer and the
  // stall baseline
  const beginWait = useCallback(() =>
  {
    setWaitStartedAt(Date.now())
    startWaiting()
  }, [startWaiting])

  // no tokens for a while (or a long silent wait for the first one) flags a
  // stalled stream; polled by a short interval so the flag clears itself
  const stalled = useStalledFlag(
    runStage,
    streamBuf.lastTokenAt,
    waitStartedAt,
    activePrompt !== null
  )

  const resetRunState = useCallback(() =>
  {
    resetStreamBuffer()
    resetAnimation()
    setRunStage('idle')
    setWaitStartedAt(null)
    runStartTimeRef.current = null
    toolStartTimesRef.current.clear()
  }, [resetAnimation, resetStreamBuffer])

  const restoreSession = useCallback(
    (restored: SessionData, estimatedTokens: number) =>
    {
      setOutput(buildRestoredBlocks(restored.messages, restored.undo))
      setTranscriptEpoch((epoch) => epoch + 1)
      setTokenUsage({ ...EMPTY_TOKEN_USAGE, context: estimatedTokens })
      resetRunState()
      scrollToLatest()
    },
    [resetRunState, scrollToLatest]
  )

  const clearSession = useCallback(() =>
  {
    setOutput([])
    setTranscriptEpoch((epoch) => epoch + 1)
    setTokenUsage(EMPTY_TOKEN_USAGE)
    resetRunState()
    scrollToLatest()
  }, [resetRunState, scrollToLatest])

  const resetTokenUsage = useCallback((estimatedTokens: number) =>
  {
    setTokenUsage({ ...EMPTY_TOKEN_USAGE, context: estimatedTokens })
  }, [])

  const view = useMemo<InteractiveSessionView>(
    () => ({ restoreSession, clearSession, resetTokenUsage }),
    [clearSession, resetTokenUsage, restoreSession]
  )

  const rebuildTranscript = useCallback(
    (target: Agent | null = agent) =>
    {
      setOutput(
        target
          ? buildRestoredBlocks(target.getMessages(), target.getUndoStack())
          : []
      )
      setTranscriptEpoch((epoch) => epoch + 1)
      setTokenUsage((previous) => ({
        ...previous,
        context: target?.getEstimatedTokens() ?? 0,
        contextEstimated: true,
      }))
      scrollToLatest()
    },
    [agent, scrollToLatest]
  )

  useEffect(() =>
  {
    if (runStage === 'idle' || runStartTimeRef.current == null)
    {
      queueMicrotask(() =>
      {
        setRunElapsed(null)
      })
      return
    }

    const updateRunElapsed = () =>
    {
      if (runStartTimeRef.current != null)
      {
        setRunElapsed(formatElapsed(Date.now() - runStartTimeRef.current))
      }
    }

    updateRunElapsed()
    const timer = setInterval(updateRunElapsed, 250)
    return () =>
    {
      clearInterval(timer)
    }
  }, [runStage])

  const run = useCallback(
    async (value: string, runOptions: RunAgentTurnOptions): Promise<void> =>
    {
      const operation = beginOperation('turn')
      if (!operation) return
      const runAgent = operation.agent
      const presentedContent = runOptions.displayContent ?? value
      let acceptedTurn: AcceptedTurn | null = null

      const completeFailedTurn = (message: string) =>
      {
        // a turn that failed before its run started would otherwise stay
        // accepted and refuse every later submit
        if (acceptedTurn) runAgent.releaseAcceptedTurn(acceptedTurn)
        const completion = completeTurn(operation)
        if (!completion.accepted) return
        onInterrupted()
        const pendingBlocks = consumeBufferedBlocks()
        const toolStarts = new Map(toolStartTimesRef.current)
        const finishedAt = Date.now()
        setOutput((previous) => [
          ...failPendingToolCalls(previous, toolStarts, finishedAt),
          ...pendingBlocks,
          { type: 'error', content: message },
          ...persistenceBlocks(completion),
        ])
        resetRunState()
      }

      try
      {
        acceptedTurn = runAgent.acceptTurn({
          content: value,
          displayContent: runOptions.displayContent,
          attachmentPaths: runOptions.attachmentPaths,
        })
      }
      catch (error)
      {
        completeFailedTurn(toErrorMessage(error))
        return
      }
      const turn = acceptedTurn

      // a settled launch or doom prompt hands a live turn back to prefill
      // (a declined doom prompt ends it right after), so the wait indicator
      // returns before the first token
      const resumeWaiting = (
        settlement: Parameters<typeof settlementApproved>[0]
      ): boolean =>
      {
        if (acceptsEvent(operation) && runStageRef.current === 'waiting')
          beginWait()
        return settlementApproved(settlement)
      }

      const task = runOperation(operation, async () =>
      {
        // prompt history is a convenience; a full or read-only disk must not
        // cost the user the turn itself
        let historyError: string | null = null
        if (!runOptions.historyRecorded)
        {
          try
          {
            addHistoryEntry(presentedContent.trim(), getSessionId())
          }
          catch (error)
          {
            historyError = `Prompt history not saved: ${toErrorMessage(error)}`
          }
        }

        if (!runOptions.preserveInput) clearInput()
        scrollToLatest()
        setOutput((previous) => [
          ...previous,
          { type: 'user', content: presentedContent },
          ...(historyError
            ? [{ type: 'system' as const, content: historyError }]
            : []),
        ])
        setRunStage('waiting')
        runStartTimeRef.current = Date.now()
        beginWait()
        resetStreamBuffer()

        await runAgent.runAcceptedTurn(
          turn,
          {
            onAttachments(expansion)
            {
              if (!acceptsEvent(operation)) return
              const notice = formatMentionNotice(expansion)
              if (notice)
              {
                setOutput((previous) => [
                  ...previous,
                  { type: 'system', content: notice },
                ])
              }
            },
            onThinking(thinking)
            {
              if (!acceptsEvent(operation)) return
              stopWaiting()
              setRunStage('thinking')
              appendThinking(thinking)
            },
            onToken(token)
            {
              if (!acceptsEvent(operation)) return
              stopWaiting()
              setRunStage('responding')
              appendText(token)
            },
            onToolCall(name, args, callId, presentation)
            {
              if (!acceptsEvent(operation)) return
              stopWaiting()
              const pendingBlocks = consumeBufferedBlocks()
              setRunStage(`tool:${presentation?.label ?? name}`)
              toolStartTimesRef.current.set(callId, Date.now())
              setOutput((previous) => [
                ...previous,
                ...pendingBlocks,
                {
                  type: 'tool_call',
                  toolName: name,
                  args,
                  callId,
                  display: presentation,
                } satisfies ToolCallBlock,
              ])
            },
            async onToolApproval(
              name,
              args,
              presentation,
              _callId,
              promoted,
              protectedPath
            )
            {
              if (!acceptsEvent(operation)) return false
              if (isYolo()) return true
              // an outside-workspace write still shows its content before
              // the user approves it
              const preview = await previewToolDiff(name, args, {
                cwd: runAgent.getCwd(),
                allowOutsideWorkspace: promoted === true,
              })
              if (!acceptsEvent(operation)) return false
              return requestToolApproval(operation, {
                toolName: name,
                args,
                diff: preview?.kind === 'diff' ? preview.diff : undefined,
                previewMessage:
                  preview?.kind === 'message' ? preview.message : undefined,
                presentation,
                promoted: promoted === true,
                protectedPath: protectedPath === true,
              })
            },
            onMcpLaunchApproval(request)
            {
              if (!acceptsEvent(operation)) return Promise.resolve(false)
              // yolo may use only launch identities commissioned in ask mode
              if (isYolo()) return Promise.resolve(false)
              stopWaiting()
              return requestPrompt(operation, { kind: 'mcp', request }).then(
                resumeWaiting
              )
            },
            onDoomLoop(message)
            {
              if (!acceptsEvent(operation)) return Promise.resolve(false)
              stopWaiting()
              return requestPrompt(operation, { kind: 'doom', message }).then(
                resumeWaiting
              )
            },
            onVerification(result)
            {
              if (!acceptsEvent(operation)) return
              setOutput((previous) => [
                ...previous,
                { type: 'system', content: formatVerification(result) },
              ])
            },
            onToolResult(name, result, error, callId, diff)
            {
              if (!acceptsEvent(operation)) return
              const startedAt = toolStartTimesRef.current.get(callId)
              const duration =
                startedAt != null ? Date.now() - startedAt : undefined
              toolStartTimesRef.current.delete(callId)
              setRunStage('waiting')
              beginWait()
              setOutput((previous) =>
              {
                const next = [...previous]
                for (let index = next.length - 1; index >= 0; index--)
                {
                  const block = next[index]!
                  if (
                    block.type === 'tool_call' &&
                    block.callId === callId &&
                    !block.status
                  )
                  {
                    next[index] = {
                      ...block,
                      status: error ? 'error' : 'success',
                      duration,
                    }
                    break
                  }
                }

                if (error)
                {
                  next.push({
                    type: 'tool_result',
                    toolName: name,
                    content: failedToolResultText(error, result),
                    isError: true,
                  })
                }
                else if (diff)
                {
                  next.push({ type: 'diff', unified: diff } satisfies DiffBlock)
                }
                else if (result)
                {
                  // blocks keep the full (bounded) result; collapse is a
                  // render-time decision so ctrl+o can reach the rest
                  next.push({
                    type: 'tool_result',
                    toolName: name,
                    content: capStoredOutput(result).text,
                  })
                }
                return next
              })
            },
            onUsage(usage)
            {
              if (!acceptsEvent(operation)) return
              const prefillTps = computeTokensPerSecond(
                usage.promptTokens,
                usage.promptEvalDurationNs
              )
              const decodeTps = computeTokensPerSecond(
                usage.completionTokens,
                usage.evalDurationNs
              )
              setTokenUsage((previous) => ({
                prompt: usage.totalPromptTokens,
                completion: usage.totalCompletionTokens,
                context: usage.contextTokens,
                contextEstimated: false,
                lastPrefillTps:
                  prefillTps > 0 ? prefillTps : previous.lastPrefillTps,
                lastDecodeTps:
                  decodeTps > 0 ? decodeTps : previous.lastDecodeTps,
              }))
            },
            onCompactionStart()
            {
              if (!acceptsEvent(operation)) return
              setRunStage('compacting')
            },
            onCompaction(result)
            {
              if (!acceptsEvent(operation)) return
              rebuildTranscript(runAgent)
              setOutput((previous) => [
                ...previous,
                { type: 'system', content: formatAutoCompactionResult(result) },
              ])
              setRunStage('waiting')
              beginWait()
            },
            onDone()
            {
              const completion = completeTurn(operation)
              if (!completion.accepted) return
              const pendingBlocks = consumeBufferedBlocks()
              const savedBlocks = persistenceBlocks(completion)

              if (completion.aborted)
              {
                onInterrupted()
                const toolStarts = new Map(toolStartTimesRef.current)
                const finishedAt = Date.now()
                setOutput((previous) => [
                  ...failPendingToolCalls(previous, toolStarts, finishedAt),
                  ...pendingBlocks,
                  { type: 'system', content: 'Generation interrupted' },
                  ...savedBlocks,
                ])
              }
              else
              {
                setOutput((previous) => [
                  ...previous,
                  ...pendingBlocks,
                  ...savedBlocks,
                ])
              }
              resetRunState()
            },
            onError(error)
            {
              completeFailedTurn(error.message)
            },
          },
          operation.signal
        )
      })

      await task.catch((error: unknown) =>
      {
        completeFailedTurn(toErrorMessage(error))
      })
    },
    [
      acceptsEvent,
      addHistoryEntry,
      appendText,
      appendThinking,
      beginOperation,
      beginWait,
      clearInput,
      completeTurn,
      consumeBufferedBlocks,
      getSessionId,
      isYolo,
      onInterrupted,
      rebuildTranscript,
      requestPrompt,
      requestToolApproval,
      resetRunState,
      resetStreamBuffer,
      runOperation,
      scrollToLatest,
      stopWaiting,
    ]
  )

  return {
    output,
    setOutput,
    runStage,
    runElapsed,
    tokenUsage,
    streamBuffer: streamBuf,
    spinnerTick,
    waitingElapsed,
    showWaitingIndicator,
    transcriptEpoch,
    view,
    rebuildTranscript,
    run,
    isRunning: runStage !== 'idle',
    stalled,
  }
}
