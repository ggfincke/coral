// src/tui/App.tsx
// main TUI component w/ model picking, approvals, scrollback, & session persistence

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import { Agent, type TokenUsage } from '../agent/agent.js'
import {
  OllamaClient,
  type Model,
  type OllamaMessage,
} from '../ollama/client.js'
import { buildModelPickerLines, sortModels } from './model-picker.js'
import {
  createShutdownCoordinator,
  registerSignalHandlers,
} from './shutdown.js'
import {
  buildTranscriptLines,
  maxScrollOffset,
  sliceViewport,
  summarizeToolArgs,
  type OutputBlock,
  type ToolCallBlock,
} from './transcript.js'
import PromptInput from './prompt-input.js'
import { CORAL_HEX, OCEAN_HEX } from './theme.js'
import stripAnsi from 'strip-ansi'
import { toErrorMessage } from '../utils/errors.js'
import { dispatchCommand, type CommandContext } from './commands.js'
import {
  truncateOutput,
  type TruncateOutputOptions,
} from '../utils/truncate-output.js'
import { useAnimationTimer } from './use-animation-timer.js'
import { useStreamBuffer } from './use-stream-buffer.js'
import { useSessionPersistence } from './use-session-persistence.js'
import { type RunStage } from './run-stage.js'

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
const TRUNCATED_TOOL_RESULT_OPTIONS: TruncateOutputOptions = {
  dropEmpty: false,
  separator: '\n',
  buildSuffix: (shown, total) => `… (${total - shown} more lines)`,
}

function formatElapsed(ms: number): string
{
  if (ms < 60_000)
  {
    return `${(ms / 1000).toFixed(1)}s`
  }

  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function formatTokens(n: number): string
{
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function describeRunStage(stage: RunStage): string
{
  if (stage === 'waiting') return 'waiting for model'
  if (stage === 'thinking') return 'thinking'
  if (stage === 'responding') return 'responding'
  if (stage.startsWith('tool:'))
  {
    return `running ${stage.slice(5)}`
  }
  return 'ready'
}

function clamp(value: number, min: number, max: number): number
{
  return Math.min(Math.max(value, min), max)
}

// build a token gauge string: "2.1k/8k ctx" or "2.1k tokens"
function buildTokenGauge(
  totalTokens: number,
  contextWindow: number
): string
{
  if (totalTokens === 0 && contextWindow === 0) return ''

  const used = formatTokens(totalTokens)

  if (contextWindow > 0)
  {
    const window = formatTokens(contextWindow)
    const pct = Math.min(Math.round((totalTokens / contextWindow) * 100), 100)
    return `${used}/${window} ctx (${pct}%)`
  }

  return `${used} tokens`
}

// pad a status line so left & right parts are flush to edges
function buildStatusLine(
  left: string,
  right: string,
  width: number
): string
{
  const leftVisible = stripAnsi(left).length
  const rightVisible = stripAnsi(right).length
  const gap = Math.max(width - leftVisible - rightVisible, 1)
  return left + ' '.repeat(gap) + right
}

function buildRule(width: number): string
{
  return '─'.repeat(Math.max(width, 1))
}

function buildLabeledSeparator(width: number, label: string): string
{
  const labelStr = ` ${label} `
  const remaining = Math.max(width - labelStr.length, 2)
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return `${'─'.repeat(left)}${labelStr}${'─'.repeat(right)}`
}

function formatApprovalArgs(
  toolName: string,
  args: Record<string, unknown>
): string
{
  const summary = summarizeToolArgs(toolName, args)
  return toolName === 'bash' ? `$ ${summary}` : summary
}

function truncateToolResult(result: string): string
{
  return truncateOutput(result, 30, 'lines', TRUNCATED_TOOL_RESULT_OPTIONS)
}

function buildRestoredBlocks(messages: OllamaMessage[]): OutputBlock[]
{
  const restoredBlocks: OutputBlock[] = []

  for (const msg of messages)
  {
    if (msg.role === 'system') continue

    if (msg.role === 'user')
    {
      restoredBlocks.push({ type: 'user', content: msg.content })
      continue
    }

    if (msg.role === 'assistant')
    {
      if (msg.thinking)
      {
        restoredBlocks.push({ type: 'thinking', content: msg.thinking })
      }

      if (msg.content)
      {
        restoredBlocks.push({ type: 'assistant', content: msg.content })
      }

      continue
    }

    if (msg.role === 'tool' && msg.content)
    {
      restoredBlocks.push({
        type: 'tool_result',
        toolName: msg.tool_name ?? 'tool',
        content: truncateToolResult(msg.content),
      })
    }
  }

  return restoredBlocks
}

// build bordered approval box
function buildApprovalBox(
  toolName: string,
  args: Record<string, unknown>,
  width: number
): string[]
{
  const innerWidth = Math.max(width - 4, 12)
  const summary = formatApprovalArgs(toolName, args)
  const title = `Allow ${toolName}?`

  const topBorder = `╭─${buildLabeledSeparator(innerWidth, 'tool approval')}─╮`
  const bottomBorder = `╰${buildRule(innerWidth + 2)}╯`
  const emptyLine = `│ ${' '.repeat(innerWidth)} │`

  const lines: string[] = [topBorder, emptyLine]

  const titlePadded = title + ' '.repeat(Math.max(innerWidth - title.length, 0))
  lines.push(`│ ${titlePadded} │`)

  const wrapped = wrapAnsi(summary, innerWidth, {
    hard: true,
    trim: false,
    wordWrap: true,
  })
  for (const summaryLine of wrapped.split('\n'))
  {
    const padded =
      summaryLine + ' '.repeat(Math.max(innerWidth - summaryLine.length, 0))
    lines.push(`│ ${padded} │`)
  }

  lines.push(emptyLine)

  const hint = '(y) approve  (n) reject  (esc) cancel'
  const hintPadded = hint + ' '.repeat(Math.max(innerWidth - hint.length, 0))
  lines.push(`│ ${hintPadded} │`)

  lines.push(emptyLine)
  lines.push(bottomBorder)

  return lines
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

  const { sessionIdRef, getResumeSession, persistSession } = useSessionPersistence(
    resumeSessionId
  )
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
  const [pickerState, setPickerState] = useState<'hidden' | 'loading' | 'ready' | 'error'>(
    model ? 'hidden' : 'loading'
  )
  const [pickerError, setPickerError] = useState('')
  const [models, setModels] = useState<Model[]>([])
  const [selectedModelIndex, setSelectedModelIndex] = useState(0)
  const [input, setInput] = useState('')
  const [output, setOutput] = useState<OutputBlock[]>(() =>
    resumeSession ? buildRestoredBlocks(resumeSession.messages) : []
  )
  const [showThinking, setShowThinking] = useState(true)
  const [yolo, setYolo] = useState(initialYolo)
  const [runStage, setRunStage] = useState<RunStage>('idle')
  const [approval, setApproval] = useState<ApprovalPrompt | null>(null)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [runElapsed, setRunElapsed] = useState<string | null>(null)
  const [sessionLabelId, setSessionLabelId] = useState<string | null>(
    resumeSession?.meta.id ?? resumeSessionId ?? null
  )
  const [tokenUsage, setTokenUsage] = useState({ prompt: 0, completion: 0 })
  const [contextWindow, setContextWindow] = useState(0)
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

  const agentRef = useRef<Agent | null>(agent)
  const previousLineCountRef = useRef(0)
  const disposedAgentsRef = useRef(new WeakSet<Agent>())
  const runStartTimeRef = useRef<number | null>(null)
  const toolStartTimeRef = useRef<number | null>(null)
  const runAbortRef = useRef<AbortController | null>(null)
  const maxOffsetRef = useRef(0)
  const chatViewportHeightRef = useRef(6)

  const isRunning = runStage !== 'idle'
  const transcriptWidth = Math.max(terminalSize.columns - 2, 20)

  const approvalBoxLines = approval
    ? buildApprovalBox(approval.toolName, approval.args, transcriptWidth)
    : []
  const headerHeight = 2
  const inputHeight = approval ? 0 : 3
  const statusHeight = 1
  const approvalHeight = approval ? approvalBoxLines.length + 1 : 0
  const chatViewportHeight = Math.max(
    terminalSize.rows -
      headerHeight -
      inputHeight -
      statusHeight -
      approvalHeight,
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
      }),
    [
      output,
      showThinking,
      showWaitingIndicator,
      spinnerTick,
      streamBuf,
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
    setTokenUsage({ prompt: 0, completion: 0 })
    sessionIdRef.current = null
  }, [sessionIdRef])

  // show the model picker — preserves current agent for in-place switching
  // uses loadModelsRef to avoid circular dependency w/ loadModels/activateModel
  const loadModelsRef = useRef<() => Promise<void>>()
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

  // fetch context window size from Ollama & update state
  const fetchContextWindowForAgent = useCallback((agentInstance: Agent) =>
  {
    void agentInstance.fetchContextWindow().then((size) =>
    {
      if (size > 0) setContextWindow(size)
    })
  }, [])

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

  loadModelsRef.current = loadModels

  useEffect(() =>
  {
    maxOffsetRef.current = maxOffset
  }, [maxOffset])

  useEffect(() =>
  {
    chatViewportHeightRef.current = chatViewportHeight
  }, [chatViewportHeight])

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
        runAbortRef.current = null
      }

      setInput('')
      setScrollOffset(0)
      setOutput((prev) => [...prev, { type: 'user', content: value }])
      setRunStage('waiting')
      runStartTimeRef.current = Date.now()
      startWaiting()
      resetStreamBuffer()

      await agent.run(value, {
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
        onToolCall(name, args)
        {
          stopWaiting()

          const pendingBlocks = consumeBufferedBlocks()
          setRunStage(`tool:${name}`)
          toolStartTimeRef.current = Date.now()

          setOutput((prev) => [
            ...prev,
            ...pendingBlocks,
            {
              type: 'tool_call',
              toolName: name,
              args,
            } satisfies ToolCallBlock,
          ])
        },
        onToolApproval(name, args)
        {
          if (yolo) return Promise.resolve(true)

          return new Promise<boolean>((resolve) =>
          {
            setApproval({ toolName: name, args, resolve })
          })
        },
        onToolResult(name, result, error)
        {
          const duration = toolStartTimeRef.current
            ? Date.now() - toolStartTimeRef.current
            : undefined
          toolStartTimeRef.current = null

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
                block.toolName === name &&
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
          setTokenUsage({
            prompt: usage.totalPromptTokens,
            completion: usage.totalCompletionTokens,
          })
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
      }, controller.signal)
    },
    [
      activeModel,
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
      reopenModelPicker,
      resetAnimation,
      resetStreamBuffer,
      runStage,
      sessionLabelId,
      startWaiting,
      stopWaiting,
      switchModel,
      yolo,
    ]
  )

  const sessionLabel = sessionLabelId ? `session ${sessionLabelId}` : ''
  const permissionMode = yolo ? 'yolo' : 'ask'
  const totalTokens = tokenUsage.prompt + tokenUsage.completion
  const tokenGauge = buildTokenGauge(totalTokens, contextWindow)

  const pickerEscHint = agent ? 'esc returns to chat' : 'esc quits'
  let statusLine: string

  if (pickerVisible)
  {
    statusLine = pickerState === 'loading'
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
    const stateLeft = tokenGauge
      ? `${stageStr} · ${tokenGauge}`
      : stageStr
    statusLine = buildStatusLine(stateLeft, 'ctrl+c interrupts', transcriptWidth)
  }
  else
  {
    // idle state — show token gauge on left, minimal hints on right
    const stateLeft = tokenGauge ? tokenGauge : 'ready'
    const yoloHint = yolo ? chalk.yellow('⚠ yolo') : ''
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
          <Text bold color={CORAL_HEX}>
            coral
          </Text>
          <Text dimColor>{' · '}</Text>
          <Text color="white">{activeModel || 'pick a model'}</Text>
          <Text dimColor>{' · '}</Text>
          {yolo ? (
            <Text backgroundColor="yellow" color="black" bold>
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

      {!pickerVisible && agent && approval && (
        <Box flexDirection="column">
          {approvalBoxLines.map((line, index) => (
            <Text key={index} color="yellow">
              {line}
            </Text>
          ))}
        </Box>
      )}

      {!pickerVisible && agent && !approval && (
        <Box flexDirection="column">
          <Text dimColor color={yolo ? 'yellow' : undefined}>{headerSep}</Text>
          <Box>
            <Text bold color={yolo ? 'yellow' : OCEAN_HEX}>
              {yolo ? ' ⚡ ' : ' ❯ '}
            </Text>
            <PromptInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              onEscape={handleEscape}
              onInterrupt={handleInterrupt}
              onPageUp={onPageUp}
              onPageDown={onPageDown}
              onScrollUp={onScrollUp}
              onScrollDown={onScrollDown}
              onToggleThinking={onToggleThinking}
              onTogglePermissions={onTogglePermissions}
              placeholder={isRunning ? 'thinking...' : 'ask coral anything'}
            />
          </Box>
        </Box>
      )}

      <Text dimColor> {statusLine}</Text>
    </Box>
  )
}
