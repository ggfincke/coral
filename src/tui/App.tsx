// src/tui/App.tsx
// main TUI component w/ model picking, approvals, scrollback, & session persistence

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { Agent } from '../agent/agent.js'
import { OllamaClient } from '../ollama/client.js'
import type { Model } from '../types/inference.js'
import { buildModelPickerLines, sortModels } from './model-picker.js'
import {
  createShutdownCoordinator,
  registerSignalHandlers,
} from './shutdown.js'
import {
  buildTranscriptLines,
  maxScrollOffset,
  sliceViewport,
  type OutputBlock,
  type ToolCallBlock,
} from './transcript.js'
import PromptInput from './prompt-input.js'
import { getThemeGeneration, inkColor, style } from './theme.js'
import { toErrorMessage } from '../utils/errors.js'
import { dispatchCommand, type CommandContext } from './commands.js'
import { useAnimationTimer } from './use-animation-timer.js'
import { useStreamBuffer } from './use-stream-buffer.js'
import { useSessionPersistence } from './use-session-persistence.js'
import { useInputHistory } from './use-input-history.js'
import { loadSession, renameSession } from '../session/store.js'
import { type RunStage } from './run-stage.js'
import {
  buildTokenGauge,
  computeTokensPerSecond,
  formatElapsed,
  formatTokenCount,
  formatTokensPerSecond,
} from './metrics.js'
import { buildApprovalBox } from './approval-box.js'
import { buildRestoredBlocks, truncateToolResult } from './restored-blocks.js'
import { buildRule, buildStatusLine, describeRunStage } from './status-line.js'
import { buildTodoPanel } from './todo-panel.js'
import {
  getTodos,
  clearTodos,
  onTodosChanged,
  type TodoItem,
} from '../tools/todo-store.js'

interface Props
{
  model?: string
  host: string
  think: boolean
  yolo: boolean
  resumeSessionId?: string
}

interface ApprovalPrompt
{
  toolName: string
  args: Record<string, unknown>
  resolve: (approved: boolean) => void
}

const FLUSH_INTERVAL = 32
const SPINNER_INTERVAL = 80
const SCROLL_LINES = 3

function clamp(value: number, min: number, max: number): number
{
  return Math.min(Math.max(value, min), max)
}

export default function App({
  model,
  host,
  think,
  yolo: initialYolo,
  resumeSessionId,
}: Props)
{
  const { exit } = useApp()
  const { stdout } = useStdout()
  const terminal = stdout as typeof process.stdout

  const { sessionIdRef, sessionMetaRef, getResumeSession, persistSession } =
    useSessionPersistence(resumeSessionId)
  const resumeSession = getResumeSession()

  const [activeModel, setActiveModel] = useState(
    model ?? resumeSession?.meta.model ?? ''
  )
  const [agent, setAgent] = useState<Agent | null>(() =>
  {
    if (!model) return null

    const nextAgent = new Agent(model, host, undefined, { think })
    if (resumeSession)
    {
      nextAgent.restoreMessages(resumeSession.messages)
    }

    return nextAgent
  })
  const [pickerState, setPickerState] = useState<
    'hidden' | 'loading' | 'ready' | 'error'
  >(model ? 'hidden' : 'loading')
  const [pickerError, setPickerError] = useState('')
  const [models, setModels] = useState<Model[]>([])
  const [selectedModelIndex, setSelectedModelIndex] = useState(0)
  const [input, setInput] = useState('')
  const [output, setOutput] = useState<OutputBlock[]>(() =>
    resumeSession ? buildRestoredBlocks(resumeSession.messages) : []
  )
  const [showThinking, setShowThinking] = useState(true)
  const [yolo, setYolo] = useState(initialYolo)
  // mirrors the module-level theme generation so theme switches re-render
  const [themeGeneration, setThemeGeneration] = useState(getThemeGeneration)
  const [runStage, setRunStage] = useState<RunStage>('idle')
  const [approval, setApproval] = useState<ApprovalPrompt | null>(null)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [runElapsed, setRunElapsed] = useState<string | null>(null)
  const [sessionLabelId, setSessionLabelId] = useState<string | null>(
    resumeSession?.meta.id ?? resumeSessionId ?? null
  )
  const [tokenUsage, setTokenUsage] = useState({
    // cumulative session totals (every turn re-prefills the context)
    prompt: 0,
    completion: 0,
    // current context occupancy — drives the ctx gauge
    context: 0,
    // last-turn throughput (tokens / second) — 0 when the server omitted durations
    lastPrefillTps: 0,
    lastDecodeTps: 0,
  })
  const [contextWindow, setContextWindow] = useState(0)
  // live task list mirrored from the todo tool's in-memory store
  const [todos, setTodos] = useState<TodoItem[]>(() => getTodos())
  const [terminalSize, setTerminalSize] = useState({
    columns: terminal.columns ?? 80,
    rows: terminal.rows ?? 24,
  })

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
  const {
    navigateUp,
    navigateDown,
    addEntry: addHistoryEntry,
    resetNavigation,
  } = useInputHistory()

  const agentRef = useRef<Agent | null>(agent)
  const previousLineCountRef = useRef(0)
  const disposedAgentsRef = useRef(new WeakSet<Agent>())
  const runStartTimeRef = useRef<number | null>(null)
  // per-call start times keyed by callId — parallel batches run several at once
  const toolStartTimesRef = useRef<Map<number, number>>(new Map())
  const runAbortRef = useRef<AbortController | null>(null)
  // live permission mode — read at approval time so a mid-run toggle takes effect
  const yoloRef = useRef(yolo)
  const maxOffsetRef = useRef(0)
  const chatViewportHeightRef = useRef(6)

  const isRunning = runStage !== 'idle'
  const transcriptWidth = Math.max(terminalSize.columns - 2, 20)

  const approvalBoxLines = approval
    ? buildApprovalBox(approval.toolName, approval.args, transcriptWidth)
    : []
  const todoPanelLines = buildTodoPanel(todos, transcriptWidth)
  const headerHeight = 2
  const inputHeight = approval ? 0 : 3
  const statusHeight = 1
  const approvalHeight = approval ? approvalBoxLines.length + 1 : 0
  const todoHeight = todoPanelLines.length
  const chatViewportHeight = Math.max(
    terminalSize.rows -
      headerHeight -
      inputHeight -
      statusHeight -
      approvalHeight -
      todoHeight,
    6
  )
  const pickerViewportHeight = Math.max(
    terminalSize.rows - headerHeight - statusHeight,
    6
  )

  const transcriptLines = useMemo(
    () =>
      buildTranscriptLines({
        blocks: output,
        streaming: streamBuf.text,
        width: transcriptWidth,
        spinnerTick,
        showWaitingIndicator,
        waitingElapsed,
        streamingThinking: streamBuf.thinking,
        showThinking,
        themeGeneration,
      }),
    [
      output,
      showThinking,
      showWaitingIndicator,
      spinnerTick,
      streamBuf,
      themeGeneration,
      transcriptWidth,
      waitingElapsed,
    ]
  )
  const maxOffset = maxScrollOffset(transcriptLines.length, chatViewportHeight)
  const visibleTranscript = sliceViewport(
    transcriptLines,
    chatViewportHeight,
    scrollOffset
  )
  const paddedTranscript = [
    ...Array(Math.max(chatViewportHeight - visibleTranscript.length, 0)).fill(
      ''
    ),
    ...visibleTranscript,
  ]

  const pickerLines =
    pickerState === 'ready'
      ? buildModelPickerLines(
          models,
          selectedModelIndex,
          transcriptWidth,
          pickerViewportHeight
        )
      : pickerState === 'loading'
        ? ['Loading Ollama models…', `Host: ${host}`]
        : ['Failed to load Ollama models', `Host: ${host}`, '', pickerError]
  const visiblePicker = [
    ...Array(Math.max(pickerViewportHeight - pickerLines.length, 0)).fill(''),
    ...pickerLines.slice(-pickerViewportHeight),
  ]

  const messageCount = useMemo(
    () => output.filter((block) => block.type === 'user').length,
    [output]
  )

  const disposeAgent = useCallback(async (agentInstance: Agent | null) =>
  {
    if (!agentInstance || disposedAgentsRef.current.has(agentInstance)) return

    disposedAgentsRef.current.add(agentInstance)
    await agentInstance.dispose()
  }, [])

  // clear transcript, scroll, & session label — used by /clear
  const clearSession = useCallback(() =>
  {
    setOutput([])
    setScrollOffset(0)
    setSessionLabelId(null)
    setTokenUsage({
      prompt: 0,
      completion: 0,
      context: 0,
      lastPrefillTps: 0,
      lastDecodeTps: 0,
    })
    // task list is session-scoped & not persisted — drop it w/ the conversation
    clearTodos()
    sessionIdRef.current = null
  }, [sessionIdRef])

  // fetch context window size from Ollama & update state
  const fetchContextWindowForAgent = useCallback((agentInstance: Agent) =>
  {
    void agentInstance.fetchContextWindow().then((size) =>
    {
      if (size > 0) setContextWindow(size)
    })
  }, [])

  // force-save the current session to disk — used by /new & /resume
  const saveCurrentSession = useCallback((): string | null =>
  {
    const currentAgent = agentRef.current
    if (!currentAgent || currentAgent.getMessageCount() === 0) return null
    const meta = persistSession(currentAgent)
    if (meta)
    {
      setSessionLabelId(meta.id)
    }
    return meta?.id ?? null
  }, [persistSession])

  // rename the current session's title & update cached meta
  const renameCurrentSession = useCallback(
    (title: string): boolean =>
    {
      if (!sessionIdRef.current) return false
      const result = renameSession(sessionIdRef.current, title)
      if (result && sessionMetaRef.current)
      {
        sessionMetaRef.current = {
          ...sessionMetaRef.current,
          title,
          updatedAt: result.updatedAt,
        }
      }
      return result !== null
    },
    [sessionIdRef, sessionMetaRef]
  )

  // resume a session by ID — disposes current agent, loads & restores target
  const resumeSessionById = useCallback(
    (sessionId: string): boolean =>
    {
      const target = loadSession(sessionId)
      if (!target) return false

      const currentAgent = agentRef.current
      if (currentAgent)
      {
        void disposeAgent(currentAgent)
      }

      // rebuild transcript from saved messages
      setOutput(buildRestoredBlocks(target.messages))
      setScrollOffset(0)
      setTokenUsage({
        prompt: 0,
        completion: 0,
        context: 0,
        lastPrefillTps: 0,
        lastDecodeTps: 0,
      })
      setContextWindow(0)
      // todos aren't persisted — clear the prior session's list on resume
      clearTodos()

      // create fresh agent w/ restored messages
      const nextAgent = new Agent(target.meta.model, host, undefined, { think })
      nextAgent.restoreMessages(target.messages)

      // update session tracking
      sessionIdRef.current = target.meta.id
      sessionMetaRef.current = target.meta

      // update React state
      setAgent(nextAgent)
      setActiveModel(target.meta.model)
      setSessionLabelId(target.meta.id)

      // fetch context window for new model
      fetchContextWindowForAgent(nextAgent)

      return true
    },
    [
      disposeAgent,
      fetchContextWindowForAgent,
      host,
      sessionIdRef,
      sessionMetaRef,
      think,
    ]
  )

  // show the model picker — preserves current agent for in-place switching
  // uses loadModelsRef to avoid circular dependency w/ loadModels/activateModel
  const loadModelsRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const reopenModelPicker = useCallback(() =>
  {
    void loadModelsRef.current?.()
  }, [])

  // switch model in-place — keeps conversation history, unloads old model
  const switchModel = useCallback(async (modelName: string) =>
  {
    const currentAgent = agentRef.current
    if (!currentAgent) return

    await currentAgent.switchModel(modelName)
    setActiveModel(modelName)
  }, [])

  // abort the current agent run — called by Ctrl+C & Escape while running
  const abortRun = useCallback(() =>
  {
    const controller = runAbortRef.current
    if (controller && !controller.signal.aborted)
    {
      controller.abort()

      // dismiss any pending approval prompt
      if (approval)
      {
        approval.resolve(false)
        setApproval(null)
      }
    }
  }, [approval])

  const activateModel = useCallback(
    (nextModel: string, restoredSession = resumeSession) =>
    {
      const existingAgent = agentRef.current

      // if there's an existing agent, switch in-place to preserve history
      if (existingAgent && !restoredSession)
      {
        void existingAgent.switchModel(nextModel).then(() =>
        {
          setContextWindow(0)
          fetchContextWindowForAgent(existingAgent)
        })
        setActiveModel(nextModel)
        setPickerState('hidden')
        return
      }

      // no existing agent (or restoring a session) — create a fresh one
      if (existingAgent)
      {
        void disposeAgent(existingAgent)
      }

      setActiveModel(nextModel)
      setContextWindow(0)

      const nextAgent = new Agent(nextModel, host, undefined, { think })
      if (restoredSession)
      {
        nextAgent.restoreMessages(restoredSession.messages)
        setOutput(buildRestoredBlocks(restoredSession.messages))
      }

      setAgent(nextAgent)
      setPickerState('hidden')
      fetchContextWindowForAgent(nextAgent)
    },
    [disposeAgent, fetchContextWindowForAgent, host, resumeSession, think]
  )

  const loadModels = useCallback(async () =>
  {
    setPickerState('loading')
    setPickerError('')

    try
    {
      const client = new OllamaClient(host)
      const loadedModels = sortModels(await client.listModels())
      const isReopening = Boolean(agentRef.current)

      // when reopening mid-session, always show the picker — don't auto-select
      if (!isReopening)
      {
        if (loadedModels.length === 1)
        {
          activateModel(loadedModels[0]!.name, resumeSession)
          return
        }

        if (resumeSession)
        {
          const sessionModel = loadedModels.find(
            (loadedModel) => loadedModel.name === resumeSession.meta.model
          )
          if (sessionModel)
          {
            activateModel(sessionModel.name, resumeSession)
            return
          }
        }
      }

      // pre-select the current model in the picker list
      const currentModelIndex = isReopening
        ? loadedModels.findIndex((m) => m.name === agentRef.current?.getModel())
        : 0

      setModels(loadedModels)
      setSelectedModelIndex(currentModelIndex >= 0 ? currentModelIndex : 0)
      setPickerState('ready')
    }
    catch (err)
    {
      setPickerError(toErrorMessage(err))
      setPickerState('error')
    }
  }, [activateModel, host, resumeSession])

  useEffect(() =>
  {
    loadModelsRef.current = loadModels
  }, [loadModels])

  useEffect(() =>
  {
    maxOffsetRef.current = maxOffset
  }, [maxOffset])

  useEffect(() =>
  {
    chatViewportHeightRef.current = chatViewportHeight
  }, [chatViewportHeight])

  // mirror the todo store into local state for the panel; detach on unmount
  // (initial state already seeded from getTodos() via useState)
  useEffect(() =>
  {
    onTodosChanged(setTodos)
    return () => onTodosChanged(null)
  }, [])

  useEffect(() =>
  {
    const updateSize = () =>
    {
      setTerminalSize({
        columns: terminal.columns ?? 80,
        rows: terminal.rows ?? 24,
      })
    }

    updateSize()
    terminal.on?.('resize', updateSize)

    return () =>
    {
      terminal.off?.('resize', updateSize)
    }
  }, [terminal])

  useEffect(() =>
  {
    if (model) return
    queueMicrotask(() =>
    {
      void loadModels()
    })
  }, [loadModels, model])

  useEffect(() =>
  {
    agentRef.current = agent
  }, [agent])

  useEffect(() =>
  {
    yoloRef.current = yolo
  }, [yolo])

  // fetch context window when agent becomes available (including initial mount)
  useEffect(() =>
  {
    if (agent && contextWindow === 0)
    {
      fetchContextWindowForAgent(agent)
    }
  }, [agent, contextWindow, fetchContextWindowForAgent])

  useEffect(() =>
  {
    const handleShutdown = createShutdownCoordinator(
      () => disposeAgent(agentRef.current),
      () => exit()
    )
    const onSignal = () =>
    {
      void handleShutdown()
    }

    return registerSignalHandlers(process, onSignal)
  }, [disposeAgent, exit])

  useEffect(() =>
  {
    return () =>
    {
      void disposeAgent(agent)
    }
  }, [agent, disposeAgent])

  useEffect(() =>
  {
    const nextLineCount = transcriptLines.length
    const previousLineCount = previousLineCountRef.current

    if (scrollOffset > 0 && nextLineCount > previousLineCount)
    {
      setScrollOffset(
        (current) => current + (nextLineCount - previousLineCount)
      )
    }

    previousLineCountRef.current = nextLineCount
  }, [output, scrollOffset, streamBuf, transcriptLines.length])

  useEffect(() =>
  {
    if (scrollOffset <= maxOffset) return

    queueMicrotask(() =>
    {
      setScrollOffset((current) => Math.min(current, maxOffset))
    })
  }, [maxOffset, scrollOffset])

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

  const pickerVisible = pickerState !== 'hidden'

  useInput(
    (ch, key) =>
    {
      if (approval)
      {
        if (ch === 'y' || ch === 'Y')
        {
          approval.resolve(true)
          setApproval(null)
        }
        else if (ch === 'n' || ch === 'N' || key.escape)
        {
          approval.resolve(false)
          setApproval(null)
        }

        return
      }

      if (pickerVisible)
      {
        if (pickerState === 'loading')
        {
          if (key.escape)
          {
            // if there's an agent behind the picker, go back to chat
            if (agent)
            {
              setPickerState('hidden')
            }
            else
            {
              exit()
            }
          }
          return
        }

        if (pickerState === 'error')
        {
          if (ch === 'r' || ch === 'R')
          {
            void loadModels()
          }
          else if (key.escape)
          {
            if (agent)
            {
              setPickerState('hidden')
            }
            else
            {
              exit()
            }
          }

          return
        }

        if (key.upArrow || ch === 'k')
        {
          setSelectedModelIndex((current) =>
            clamp(current - 1, 0, models.length - 1)
          )
        }
        else if (key.downArrow || ch === 'j')
        {
          setSelectedModelIndex((current) =>
            clamp(current + 1, 0, models.length - 1)
          )
        }
        else if (key.return)
        {
          const selected = models[selectedModelIndex]
          if (selected)
          {
            // when reopening mid-session, switch in-place (no restore session)
            activateModel(selected.name, agent ? undefined : resumeSession)
          }
        }
        else if (key.escape)
        {
          if (agent)
          {
            setPickerState('hidden')
          }
          else
          {
            exit()
          }
        }
      }
    },
    { isActive: pickerVisible || Boolean(approval) }
  )

  const handleSubmit = useCallback(
    async (value: string) =>
    {
      if (!agent || !value.trim() || runStage !== 'idle' || approval) return

      // record input in history (all non-empty submissions including slash commands)
      addHistoryEntry(value.trim(), sessionIdRef.current)

      // intercept slash commands before sending to the agent
      if (value.trim().startsWith('/'))
      {
        setInput('')
        setScrollOffset(0)

        const cmdCtx: CommandContext = {
          agent,
          activeModel,
          host,
          yolo,
          sessionLabelId,
          messageCount,
          pushOutput: (...blocks) =>
          {
            setOutput((prev) => [...prev, ...blocks])
          },
          clearSession,
          reopenModelPicker,
          switchModel,
          setYolo,
          exitApp: exit,
          resumeSession: resumeSessionById,
          saveCurrentSession,
          renameCurrentSession,
          notifyThemeChanged: () => setThemeGeneration(getThemeGeneration()),
        }

        const result = await dispatchCommand(value.trim(), cmdCtx)
        if (result.handled) return
      }

      const controller = new AbortController()
      runAbortRef.current = controller

      const resetRunState = () =>
      {
        resetStreamBuffer()
        resetAnimation()
        setRunStage('idle')
        runStartTimeRef.current = null
        toolStartTimesRef.current.clear()
        runAbortRef.current = null
      }

      setInput('')
      setScrollOffset(0)
      setOutput((prev) => [...prev, { type: 'user', content: value }])
      setRunStage('waiting')
      runStartTimeRef.current = Date.now()
      startWaiting()
      resetStreamBuffer()

      await agent.run(
        value,
        {
          onThinking(thinking)
          {
            stopWaiting()
            setRunStage('thinking')
            appendThinking(thinking)
          },
          onToken(token)
          {
            stopWaiting()
            setRunStage('responding')
            appendText(token)
          },
          onToolCall(name, args, callId)
          {
            stopWaiting()

            const pendingBlocks = consumeBufferedBlocks()
            setRunStage(`tool:${name}`)
            toolStartTimesRef.current.set(callId, Date.now())

            setOutput((prev) => [
              ...prev,
              ...pendingBlocks,
              {
                type: 'tool_call',
                toolName: name,
                args,
                callId,
              } satisfies ToolCallBlock,
            ])
          },
          onToolApproval(name, args)
          {
            if (yoloRef.current) return Promise.resolve(true)

            return new Promise<boolean>((resolve) =>
            {
              setApproval({ toolName: name, args, resolve })
            })
          },
          onToolResult(name, result, error, callId)
          {
            const startedAt = toolStartTimesRef.current.get(callId)
            const duration =
              startedAt != null ? Date.now() - startedAt : undefined
            toolStartTimesRef.current.delete(callId)

            setRunStage('waiting')
            startWaiting()

            setOutput((prev) =>
            {
              const next = [...prev]

              for (let i = next.length - 1; i >= 0; i--)
              {
                const block = next[i]!
                if (
                  block.type === 'tool_call' &&
                  block.callId === callId &&
                  !block.status
                )
                {
                  next[i] = {
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
              else if (result)
              {
                next.push({
                  type: 'tool_result',
                  toolName: name,
                  content: truncateToolResult(result),
                })
              }

              return next
            })
          },
          onUsage(usage)
          {
            const prefillTps = computeTokensPerSecond(
              usage.promptTokens,
              usage.promptEvalDurationNs
            )
            const decodeTps = computeTokensPerSecond(
              usage.completionTokens,
              usage.evalDurationNs
            )
            setTokenUsage((prev) => ({
              prompt: usage.totalPromptTokens,
              completion: usage.totalCompletionTokens,
              context: usage.contextTokens,
              // keep the previous throughput if the current turn reported nothing
              // (e.g., a cache-only hit w/ zero decode tokens)
              lastPrefillTps: prefillTps > 0 ? prefillTps : prev.lastPrefillTps,
              lastDecodeTps: decodeTps > 0 ? decodeTps : prev.lastDecodeTps,
            }))
          },
          onCompactionStart()
          {
            setRunStage('compacting')
          },
          onCompaction(result)
          {
            const saved = result.beforeTokens - result.afterTokens
            let content: string

            if (result.type === 'pruned')
            {
              content = `Auto-pruned ${result.prunedResults ?? 0} old tool results (~${formatTokenCount(saved)} tokens freed)`
            }
            else if (result.type === 'trimmed')
            {
              content = [
                `Context trimmed to recent history (summarization unavailable)`,
                `  ${result.beforeMessages} -> ${result.afterMessages} messages`,
                `  ~${formatTokenCount(result.beforeTokens)} -> ~${formatTokenCount(result.afterTokens)} tokens (~${formatTokenCount(saved)} freed)`,
              ].join('\n')
            }
            else
            {
              content = [
                `Context auto-compacted`,
                `  ${result.beforeMessages} -> ${result.afterMessages} messages`,
                `  ~${formatTokenCount(result.beforeTokens)} -> ~${formatTokenCount(result.afterTokens)} tokens (~${formatTokenCount(saved)} freed)`,
              ].join('\n')
            }

            setOutput((prev) => [...prev, { type: 'system', content }])
            setRunStage('waiting')
            startWaiting()
          },
          onDone()
          {
            const wasAborted = controller.signal.aborted
            const pendingBlocks = consumeBufferedBlocks()

            if (wasAborted)
            {
              setOutput((prev) => [
                ...prev,
                ...pendingBlocks,
                { type: 'system', content: 'Generation interrupted' },
              ])
            }
            else
            {
              setOutput((prev) => [...prev, ...pendingBlocks])
            }

            resetRunState()
            const meta = persistSession(agent)
            if (meta)
            {
              setSessionLabelId(meta.id)
            }
          },
          onError(error)
          {
            const pendingBlocks = consumeBufferedBlocks()
            setOutput((prev) => [
              ...prev,
              ...pendingBlocks,
              { type: 'error', content: error.message },
            ])
            resetRunState()
            const meta = persistSession(agent)
            if (meta)
            {
              setSessionLabelId(meta.id)
            }
          },
        },
        controller.signal
      )
    },
    [
      activeModel,
      addHistoryEntry,
      agent,
      approval,
      appendText,
      appendThinking,
      clearSession,
      consumeBufferedBlocks,
      exit,
      host,
      messageCount,
      persistSession,
      renameCurrentSession,
      reopenModelPicker,
      resetAnimation,
      resetStreamBuffer,
      resumeSessionById,
      runStage,
      saveCurrentSession,
      sessionIdRef,
      sessionLabelId,
      startWaiting,
      stopWaiting,
      switchModel,
      yolo,
    ]
  )

  const sessionLabel = sessionLabelId ? `session ${sessionLabelId}` : ''
  const permissionMode = yolo ? 'yolo' : 'ask'
  // ctx gauge reflects current context occupancy, not lifetime throughput
  const tokenGauge = buildTokenGauge(tokenUsage.context, contextWindow)
  // cumulative tokens processed this session — distinct from occupancy above
  const sessionTokens = tokenUsage.prompt + tokenUsage.completion
  const sessionGauge =
    sessionTokens > 0 ? `${formatTokenCount(sessionTokens)} tok session` : ''

  // last-turn throughput — compact "45 tok/s · 210 tok/s prefill" or empty string
  // decode tok/s is the number the user feels, so it leads
  const decodeTpsStr = formatTokensPerSecond(tokenUsage.lastDecodeTps)
  const prefillTpsStr = formatTokensPerSecond(tokenUsage.lastPrefillTps)
  const perfGauge = decodeTpsStr
    ? prefillTpsStr
      ? `${decodeTpsStr} · ${prefillTpsStr} prefill`
      : decodeTpsStr
    : ''

  const pickerEscHint = agent ? 'esc returns to chat' : 'esc quits'
  let statusLine: string

  if (pickerVisible)
  {
    statusLine =
      pickerState === 'loading'
        ? 'loading models from Ollama…'
        : pickerState === 'error'
          ? `press r to retry · ${pickerEscHint}`
          : `${models.length} models available · enter selects · ${pickerEscHint}`
  }
  else if (!agent || approval)
  {
    statusLine = ''
  }
  else if (scrollOffset > 0)
  {
    const stateLeft = isRunning
      ? `scrollback · ${describeRunStage(runStage)} · ${runElapsed ?? '0.0s'}`
      : `scrollback · ${scrollOffset} lines above`
    const hintRight = isRunning
      ? 'ctrl+c interrupts · pgdn returns'
      : 'pgdn returns'
    statusLine = buildStatusLine(stateLeft, hintRight, transcriptWidth)
  }
  else if (isRunning)
  {
    const stageStr = runElapsed
      ? `${describeRunStage(runStage)} · ${runElapsed}`
      : describeRunStage(runStage)
    const stateLeft = [stageStr, tokenGauge, perfGauge]
      .filter(Boolean)
      .join(' · ')
    statusLine = buildStatusLine(
      stateLeft,
      'ctrl+c interrupts',
      transcriptWidth
    )
  }
  else
  {
    // idle state — show ctx gauge, last-turn throughput, & session total on left
    const stateLeft = [tokenGauge || 'ready', perfGauge, sessionGauge]
      .filter(Boolean)
      .join(' · ')
    const yoloHint = yolo ? style('warning')('⚠ yolo') : ''
    const hints = [yoloHint, '/help', 'esc quits'].filter(Boolean).join(' · ')
    statusLine = buildStatusLine(stateLeft, hints, transcriptWidth)
  }

  const headerSep = buildRule(transcriptWidth)

  const onPageUp = useCallback(() =>
  {
    setScrollOffset((current) =>
      clamp(
        current + Math.max(chatViewportHeightRef.current - 1, 1),
        0,
        maxOffsetRef.current
      )
    )
  }, [])

  const onPageDown = useCallback(() =>
  {
    setScrollOffset((current) =>
      clamp(
        current - Math.max(chatViewportHeightRef.current - 1, 1),
        0,
        maxOffsetRef.current
      )
    )
  }, [])

  const onScrollUp = useCallback(() =>
  {
    setScrollOffset((current) =>
      clamp(current + SCROLL_LINES, 0, maxOffsetRef.current)
    )
  }, [])

  const onScrollDown = useCallback(() =>
  {
    setScrollOffset((current) =>
      clamp(current - SCROLL_LINES, 0, maxOffsetRef.current)
    )
  }, [])

  const onToggleThinking = useCallback(() =>
  {
    setShowThinking((current) => !current)
  }, [])

  const onTogglePermissions = useCallback(() =>
  {
    setYolo((current) =>
    {
      const next = !current
      setOutput((prev) => [
        ...prev,
        {
          type: 'system' as const,
          content: next
            ? 'Permission mode → yolo (all tool calls auto-approved)'
            : 'Permission mode → ask (prompt before writes & shell commands)',
        },
      ])
      return next
    })
  }, [])

  const onHistoryUp = useCallback(() =>
  {
    const entry = navigateUp(input)
    if (entry !== null)
    {
      setInput(entry)
    }
  }, [input, navigateUp])

  const onHistoryDown = useCallback(() =>
  {
    const entry = navigateDown()
    if (entry !== null)
    {
      setInput(entry)
    }
  }, [navigateDown])

  // wrap setInput to reset history navigation on manual edits
  const handleInputChange = useCallback(
    (value: string) =>
    {
      resetNavigation()
      setInput(value)
    },
    [resetNavigation]
  )

  // escape while running aborts the turn; escape while idle exits
  const handleEscape = useCallback(() =>
  {
    if (runAbortRef.current && !runAbortRef.current.signal.aborted)
    {
      abortRun()
    }
    else
    {
      exit()
    }
  }, [abortRun, exit])

  // Ctrl+C while running aborts the turn; Ctrl+C while idle exits
  const handleInterrupt = useCallback(() =>
  {
    if (runAbortRef.current && !runAbortRef.current.signal.aborted)
    {
      abortRun()
    }
    else
    {
      exit()
    }
  }, [abortRun, exit])

  return (
    <Box flexDirection="column" height={terminalSize.rows}>
      <Box>
        <Text>
          <Text bold color={inkColor('primary')}>
            coral
          </Text>
          <Text dimColor>{' · '}</Text>
          <Text color="white">{activeModel || 'pick a model'}</Text>
          <Text dimColor>{' · '}</Text>
          {yolo ? (
            <Text backgroundColor={inkColor('warning')} color="black" bold>
              {' YOLO '}
            </Text>
          ) : (
            <Text dimColor>{permissionMode}</Text>
          )}
          {sessionLabel && (
            <>
              <Text dimColor>{' · '}</Text>
              <Text dimColor>{sessionLabel}</Text>
            </>
          )}
          {messageCount > 0 && (
            <>
              <Text dimColor>{' · '}</Text>
              <Text dimColor>
                {messageCount} {messageCount === 1 ? 'message' : 'messages'}
              </Text>
            </>
          )}
        </Text>
      </Box>

      <Text dimColor>{headerSep}</Text>

      {pickerVisible ? (
        <Box flexDirection="column">
          {visiblePicker.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      ) : agent ? (
        <Box flexDirection="column">
          {paddedTranscript.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      ) : null}

      {!pickerVisible && agent && todoPanelLines.length > 0 && (
        <Box flexDirection="column">
          {todoPanelLines.map((line, index) => (
            <Text key={index} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}

      {!pickerVisible && agent && approval && (
        <Box flexDirection="column">
          {approvalBoxLines.map((line, index) => (
            <Text key={index} color={inkColor('warning')}>
              {line}
            </Text>
          ))}
        </Box>
      )}

      {!pickerVisible && agent && !approval && (
        <Box flexDirection="column">
          <Text dimColor color={yolo ? inkColor('warning') : undefined}>
            {headerSep}
          </Text>
          <Box>
            <Text bold color={yolo ? inkColor('warning') : inkColor('user')}>
              {yolo ? ' ⚡ ' : ' ❯ '}
            </Text>
            <PromptInput
              value={input}
              onChange={handleInputChange}
              onSubmit={handleSubmit}
              onEscape={handleEscape}
              onInterrupt={handleInterrupt}
              onPageUp={onPageUp}
              onPageDown={onPageDown}
              onScrollUp={onScrollUp}
              onScrollDown={onScrollDown}
              onToggleThinking={onToggleThinking}
              onTogglePermissions={onTogglePermissions}
              onHistoryUp={onHistoryUp}
              onHistoryDown={onHistoryDown}
              placeholder={isRunning ? '' : 'ask coral anything'}
            />
          </Box>
        </Box>
      )}

      <Text dimColor> {statusLine}</Text>
    </Box>
  )
}
