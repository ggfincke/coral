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

// timer-polled stall flag: token-driven stages measure since the last chunk,
// the waiting stage measures since the run began
function useStalledFlag(
  runStage: RunStage,
  lastTokenAt: number | null,
  startedAt: () => number | null
): boolean
{
  const [stalled, setStalled] = useState(false)

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
      if (!stageActive)
      {
        setStalled(false)
        return
      }

      const now = Date.now()
      const since = runStage === 'waiting' ? (startedAt() ?? now) : lastTokenAt
      setStalled(since !== null && now - since > STALL_WARNING_MS)
    }, SPINNER_INTERVAL)

    return () => clearInterval(timer)
  }, [lastTokenAt, runStage, startedAt])

  return stalled
}
const SPINNER_INTERVAL = 80

export interface TokenUsageView
{
  prompt: number
  completion: number
  context: number
  lastPrefillTps: number
  lastDecodeTps: number
}

const EMPTY_TOKEN_USAGE: TokenUsageView = {
  prompt: 0,
  completion: 0,
  context: 0,
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
}

export interface RunAgentTurnOptions
{
  historyRecorded: boolean
  attachmentPaths: string[]
  // autosends leave a newer unsubmitted composer draft intact
  preserveInput?: boolean
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
  view: InteractiveSessionView
  rebuildTranscript: (agent?: Agent | null) => void
  run: (value: string, options: RunAgentTurnOptions) => Promise<void>
  isRunning: boolean
  // true while tokens have stopped flowing past the stall threshold
  stalled: boolean
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
  } = options
  const {
    agent,
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
    initialSession ? buildRestoredBlocks(initialSession.messages) : []
  )
  const [runStage, setRunStage] = useState<RunStage>('idle')
  const [runElapsed, setRunElapsed] = useState<string | null>(null)
  const [tokenUsage, setTokenUsage] = useState(EMPTY_TOKEN_USAGE)
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

  // no tokens for a while (or a long silent wait for the first one) flags a
  // stalled stream; polled by a short interval so the flag clears itself
  const stalled = useStalledFlag(
    runStage,
    streamBuf.lastTokenAt,
    () => runStartTimeRef.current
  )

  const resetRunState = useCallback(() =>
  {
    resetStreamBuffer()
    resetAnimation()
    setRunStage('idle')
    runStartTimeRef.current = null
    toolStartTimesRef.current.clear()
  }, [resetAnimation, resetStreamBuffer])

  const restoreSession = useCallback(
    (restored: SessionData) =>
    {
      setOutput(buildRestoredBlocks(restored.messages))
      setTokenUsage(EMPTY_TOKEN_USAGE)
      resetRunState()
      scrollToLatest()
    },
    [resetRunState, scrollToLatest]
  )

  const clearSession = useCallback(() =>
  {
    setOutput([])
    setTokenUsage(EMPTY_TOKEN_USAGE)
    resetRunState()
    scrollToLatest()
  }, [resetRunState, scrollToLatest])

  const resetTokenUsage = useCallback(() =>
  {
    setTokenUsage(EMPTY_TOKEN_USAGE)
  }, [])

  const view = useMemo<InteractiveSessionView>(
    () => ({ restoreSession, clearSession, resetTokenUsage }),
    [clearSession, resetTokenUsage, restoreSession]
  )

  const rebuildTranscript = useCallback(
    (target: Agent | null = agent) =>
    {
      setOutput(target ? buildRestoredBlocks(target.getMessages()) : [])
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
      const acceptedTurn = runAgent.acceptTurn({
        content: value,
        attachmentPaths: runOptions.attachmentPaths,
      })

      const completeFailedTurn = (message: string) =>
      {
        const completion = completeTurn(operation)
        if (!completion.accepted) return
        const pendingBlocks = consumeBufferedBlocks()
        const toolStarts = new Map(toolStartTimesRef.current)
        const finishedAt = Date.now()
        setOutput((previous) => [
          ...failPendingToolCalls(previous, toolStarts, finishedAt),
          ...pendingBlocks,
          { type: 'error', content: message },
          ...(completion.persistence === 'error'
            ? [
                {
                  type: 'error' as const,
                  content:
                    'Session save failed; this turn may not be available after exit.',
                },
              ]
            : []),
        ])
        resetRunState()
      }

      const task = runOperation(operation, async () =>
      {
        if (!runOptions.historyRecorded)
        {
          addHistoryEntry(value.trim(), getSessionId())
        }

        if (!runOptions.preserveInput) clearInput()
        scrollToLatest()
        setOutput((previous) => [...previous, { type: 'user', content: value }])
        setRunStage('waiting')
        runStartTimeRef.current = Date.now()
        startWaiting()
        resetStreamBuffer()

        await runAgent.runAcceptedTurn(
          acceptedTurn,
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
            async onToolApproval(name, args, presentation)
            {
              if (!acceptsEvent(operation)) return false
              if (isYolo()) return true
              const preview = await previewToolDiff(name, args, {
                cwd: runAgent.getCwd(),
              })
              if (!acceptsEvent(operation)) return false
              return requestToolApproval(operation, {
                toolName: name,
                args,
                diff: preview?.kind === 'diff' ? preview.diff : undefined,
                previewMessage:
                  preview?.kind === 'message' ? preview.message : undefined,
                presentation,
              })
            },
            onMcpLaunchApproval(request)
            {
              if (!acceptsEvent(operation)) return Promise.resolve(false)
              // yolo may use only launch identities commissioned in ask mode
              if (isYolo()) return Promise.resolve(false)
              stopWaiting()
              return requestPrompt(operation, { kind: 'mcp', request }).then(
                settlementApproved
              )
            },
            onDoomLoop(message)
            {
              if (!acceptsEvent(operation)) return Promise.resolve(false)
              stopWaiting()
              return requestPrompt(operation, { kind: 'doom', message }).then(
                settlementApproved
              )
            },
            onVerification(result)
            {
              if (!acceptsEvent(operation)) return
              const label = pluralize(result.editCount, 'edit')
              let content: string
              if (result.status === 'pass')
              {
                content = `${style('success')('✓ self-check passed')} — ${label} reviewed`
              }
              else if (result.status === 'fail')
              {
                const reason =
                  result.reason ?? 'change may not match the request'
                content = `${style('warning')(`⚠ self-check flagged ${label}`)}: ${reason}${
                  result.retrying ? ' — asking the model to fix it' : ''
                }`
              }
              else
              {
                content = `self-check inconclusive — ${label} reviewed`
              }
              setOutput((previous) => [
                ...previous,
                { type: 'system', content },
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
              startWaiting()
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
                    content: error,
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
              startWaiting()
            },
            onDone()
            {
              const completion = completeTurn(operation)
              if (!completion.accepted) return
              const pendingBlocks = consumeBufferedBlocks()
              const persistenceBlocks: OutputBlock[] =
                completion.persistence === 'error'
                  ? [
                      {
                        type: 'error',
                        content:
                          'Session save failed; this turn may not be available after exit.',
                      },
                    ]
                  : []

              if (completion.aborted)
              {
                const toolStarts = new Map(toolStartTimesRef.current)
                const finishedAt = Date.now()
                setOutput((previous) => [
                  ...failPendingToolCalls(previous, toolStarts, finishedAt),
                  ...pendingBlocks,
                  { type: 'system', content: 'Generation interrupted' },
                  ...persistenceBlocks,
                ])
              }
              else
              {
                setOutput((previous) => [
                  ...previous,
                  ...pendingBlocks,
                  ...persistenceBlocks,
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
      clearInput,
      completeTurn,
      consumeBufferedBlocks,
      getSessionId,
      isYolo,
      rebuildTranscript,
      requestPrompt,
      requestToolApproval,
      resetRunState,
      resetStreamBuffer,
      runOperation,
      scrollToLatest,
      startWaiting,
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
    view,
    rebuildTranscript,
    run,
    isRunning: runStage !== 'idle',
    stalled,
  }
}
