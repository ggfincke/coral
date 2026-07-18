// src/tui/App.tsx
// render the interactive terminal view & route user input

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { OllamaClient } from '../ollama/client.js'
import type { Agent } from '../agent/agent.js'
import { clamp } from '../utils/clamp.js'
import { pluralize } from '../utils/pluralize.js'
import type { Model } from '../types/inference.js'
import { buildModelPickerLines, sortModels } from './model/model-picker.js'
import { buildWelcomeLines } from './shell/welcome.js'
import {
  buildTranscriptLines,
  centerLinesVertical,
  failPendingToolCalls,
  maxScrollOffset,
  padLinesTop,
  sliceViewport,
  type DiffBlock,
  type OutputBlock,
  type ToolCallBlock,
} from './transcript/transcript.js'
import PromptInput from './components/prompt-input.js'
import CommandPalette from './components/command-palette.js'
import { getThemeGeneration, inkColor, style } from './theme.js'
import { toErrorMessage } from '../utils/errors.js'
import { previewToolDiff } from '../tools/preview.js'
import {
  commandCompletions,
  commandInfos,
  dispatchCommand,
  keybindingInfos,
  type CommandContext,
  type KeybindingAction,
} from './shell/commands.js'
import { formatMentionNotice, parseMentions } from './prompt/mentions.js'
import {
  formatAutoCompactionResult,
  formatPermissionModeChange,
  formatPermissionModeLocked,
  formatPermissionModeUnchanged,
} from './shell/command-output.js'
import { useAnimationTimer } from './hooks/use-animation-timer.js'
import { useStreamBuffer } from './hooks/use-stream-buffer.js'
import { useInputHistory } from './hooks/use-input-history.js'
import {
  resolveStartupSession,
  useInteractiveSession,
} from './hooks/use-interactive-session.js'
import { getCwd } from '../cwd.js'
import { type RunStage } from './run/run-stage.js'
import {
  buildTokenGauge,
  computeTokensPerSecond,
  formatElapsed,
  formatTokenCount,
  formatTokensPerSecond,
} from './shell/metrics.js'
import {
  buildApprovalContent,
  buildConfirmContent,
  buildMcpApprovalContent,
  renderPromptBox,
} from './run/approval-box.js'
import {
  buildRestoredBlocks,
  truncateToolResult,
} from './transcript/restored-blocks.js'
import {
  buildRule,
  buildStatusLine,
  describeRunStageWithElapsed,
} from './run/status-line.js'
import { LineList } from './components/line-list.js'
import { buildTodoPanel } from './transcript/todo-panel.js'
import { restoredSessionForPickerSelection } from './model/model-activation.js'
import { buildPaletteEntries, type PaletteEntry } from './palette.js'
import type { OperationHandle } from './session/interactive-runtime.js'

export interface AppProps
{
  model?: string
  host: string
  think: boolean
  yolo: boolean
  resumeSessionId?: string
}

const FLUSH_INTERVAL = 32
const SPINNER_INTERVAL = 80
const SCROLL_LINES = 3

interface SlashDispatchResult
{
  admitted: boolean
  handled: boolean
}

// zeroed token-usage state — initial value & reset target
const EMPTY_TOKEN_USAGE = {
  // cumulative session totals (every turn re-prefills the context)
  prompt: 0,
  completion: 0,
  // current context occupancy — drives the ctx gauge
  context: 0,
  // last-turn throughput (tokens / second) — 0 when the server omitted durations
  lastPrefillTps: 0,
  lastDecodeTps: 0,
}

export default function App({
  model,
  host,
  think,
  yolo: initialYolo,
  resumeSessionId,
}: AppProps)
{
  const { exit } = useApp()
  const { stdout } = useStdout()
  const terminal = stdout as typeof process.stdout

  const [resumeSession] = useState(
    () => resolveStartupSession(resumeSessionId).session
  )
  const [pickerState, setPickerState] = useState<
    'hidden' | 'loading' | 'ready' | 'error'
  >(model ? 'hidden' : 'loading')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [pickerErrorTitle, setPickerErrorTitle] = useState(
    'Failed to load Ollama models'
  )
  const [pickerError, setPickerError] = useState('')
  const [models, setModels] = useState<Model[]>([])
  const [selectedModelIndex, setSelectedModelIndex] = useState(0)
  const [input, setInput] = useState('')
  const [output, setOutput] = useState<OutputBlock[]>(() =>
    resumeSession ? buildRestoredBlocks(resumeSession.messages) : []
  )
  const [showThinking, setShowThinking] = useState(true)
  // mirrors the module-level theme generation so theme switches re-render
  const [themeGeneration, setThemeGeneration] = useState(getThemeGeneration)
  const [runStage, setRunStage] = useState<RunStage>('idle')
  // block new submits while a long slash command or an in-place model switch is
  // still in flight — keeps command/chat turns from overlapping & stops a fast
  // submit from running against the pre-switch model
  const [commandRunning, setCommandRunning] = useState(false)
  // body scroll position inside the active approval/confirm prompt
  const [promptScrollOffset, setPromptScrollOffset] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [runElapsed, setRunElapsed] = useState<string | null>(null)
  const [tokenUsage, setTokenUsage] = useState(EMPTY_TOKEN_USAGE)
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
  const previousLineCountRef = useRef(0)
  const runStartTimeRef = useRef<number | null>(null)
  // per-call start times keyed by callId — parallel batches run several at once
  const toolStartTimesRef = useRef<Map<number, number>>(new Map())
  const modelLoadAbortRef = useRef<AbortController | null>(null)

  const restoreSessionView = useCallback(
    (session: NonNullable<typeof resumeSession>) =>
    {
      setOutput(buildRestoredBlocks(session.messages))
      setScrollOffset(0)
      setTokenUsage(EMPTY_TOKEN_USAGE)
      setRunStage('idle')
      runStartTimeRef.current = null
      toolStartTimesRef.current.clear()
      resetStreamBuffer()
      resetAnimation()
    },
    [resetAnimation, resetStreamBuffer]
  )
  const clearSessionView = useCallback(() =>
  {
    setOutput([])
    setScrollOffset(0)
    setTokenUsage(EMPTY_TOKEN_USAGE)
    setRunStage('idle')
    runStartTimeRef.current = null
    toolStartTimesRef.current.clear()
    resetStreamBuffer()
    resetAnimation()
  }, [resetAnimation, resetStreamBuffer])
  const resetTokenUsageView = useCallback(() =>
  {
    setTokenUsage(EMPTY_TOKEN_USAGE)
  }, [])
  const interactiveView = useMemo(
    () => ({
      restoreSession: restoreSessionView,
      clearSession: clearSessionView,
      resetTokenUsage: resetTokenUsageView,
    }),
    [clearSessionView, resetTokenUsageView, restoreSessionView]
  )

  const interactive = useInteractiveSession({
    model,
    host,
    think,
    initialYolo,
    initialSession: resumeSession,
    exit,
    view: interactiveView,
  })
  const {
    agent,
    activeModel,
    yolo,
    contextWindow,
    transition: sessionTransition,
    activePrompt,
    sessionLabelId,
    todos,
    refreshProjectFiles,
    activateModel,
    switchModel,
    resumeSession: resumeSessionById,
    saveOperationSession,
    renameCurrentSession,
    clearCurrentSession: clearSession,
    resetTokenUsage,
    setPermissionMode: transitionPermissionMode,
    beginOperation,
    acceptsEvent,
    acceptsCommandEvent,
    acceptsCommandTerminal,
    requestPrompt,
    settlePrompt,
    completeTurn,
    finishCommand,
    runOperation,
    abortActive: abortRun,
    hasActiveOperation,
    getSessionId,
    isYolo,
    isAcceptingTransitions,
    shutdown: shutdownInteractive,
  } = interactive
  const transitioningSession = sessionTransition !== null
  const shutdown = useCallback(() =>
  {
    modelLoadAbortRef.current?.abort()
    return shutdownInteractive()
  }, [shutdownInteractive])
  const {
    navigateUp,
    navigateDown,
    addEntry: addHistoryEntry,
    resetNavigation,
  } = useInputHistory()

  const maxOffsetRef = useRef(0)
  const chatViewportHeightRef = useRef(6)
  // prompt viewport geometry for the modal scroll keys
  const promptViewportRef = useRef({ maxOffset: 0, pageSize: 1 })

  const isRunning = runStage !== 'idle'
  const currentCwd = agent?.getCwd() ?? getCwd()
  const transcriptWidth = Math.max(terminalSize.columns - 2, 20)
  const pickerVisible = pickerState !== 'hidden'
  const paletteVisible = paletteOpen && !pickerVisible && Boolean(agent)

  // render the controller's one active blocking prompt
  const activePromptContent = useMemo(() =>
  {
    if (activePrompt?.kind === 'mcp')
    {
      return buildMcpApprovalContent(activePrompt.request, transcriptWidth)
    }
    if (activePrompt?.kind === 'tool')
    {
      return buildApprovalContent(
        activePrompt.toolName,
        activePrompt.args,
        transcriptWidth,
        activePrompt.diff,
        activePrompt.previewMessage,
        activePrompt.presentation
      )
    }
    if (activePrompt?.kind === 'doom')
    {
      return buildConfirmContent(
        activePrompt.message,
        transcriptWidth,
        'doom loop'
      )
    }
    return null
  }, [activePrompt, transcriptWidth])
  const todoPanelLines = useMemo(
    () => buildTodoPanel(todos, transcriptWidth),
    [todos, transcriptWidth]
  )
  const headerHeight = 2
  // any modal prompt takes over the input row
  const promptActive = Boolean(activePromptContent)
  const inputHeight = promptActive || paletteVisible ? 0 : 3
  const statusHeight = 1
  // bound the prompt so chat keeps six rows whenever terminal geometry permits
  const promptCapacity = Math.max(
    terminalSize.rows - headerHeight - statusHeight,
    1
  )
  const maxPromptRows = Math.min(
    Math.max(promptCapacity - 7, 10),
    promptCapacity
  )
  const promptRender = useMemo(
    () =>
      activePromptContent
        ? renderPromptBox(
            activePromptContent,
            transcriptWidth,
            maxPromptRows,
            promptScrollOffset
          )
        : null,
    [activePromptContent, maxPromptRows, promptScrollOffset, transcriptWidth]
  )
  const promptBoxLines = promptRender?.lines ?? []
  const approvalHeight = promptActive ? promptBoxLines.length + 1 : 0
  const todoHeight = promptActive ? 0 : todoPanelLines.length
  const chatViewportHeight = Math.max(
    terminalSize.rows -
      headerHeight -
      inputHeight -
      statusHeight -
      approvalHeight -
      todoHeight,
    promptActive ? 0 : 6
  )
  const pickerViewportHeight = Math.max(
    terminalSize.rows - headerHeight - statusHeight,
    6
  )
  const paletteViewportHeight = pickerViewportHeight

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
  const paddedTranscript = padLinesTop(visibleTranscript, chatViewportHeight)

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
        : [pickerErrorTitle, `Host: ${host}`, '', pickerError]
  const visiblePicker = padLinesTop(
    pickerLines.slice(-pickerViewportHeight),
    pickerViewportHeight
  )

  const messageCount = useMemo(
    () => output.filter((block) => block.type === 'user').length,
    [output]
  )

  // launch splash: shown only while the conversation is empty, then scrolls away
  const welcomeLines = useMemo(
    () =>
      buildWelcomeLines({
        width: transcriptWidth,
        rows: chatViewportHeight,
        model: activeModel,
        cwd: currentCwd,
      }),
    [transcriptWidth, chatViewportHeight, activeModel, currentCwd]
  )
  const paddedWelcome = centerLinesVertical(welcomeLines, chatViewportHeight)

  const rebuildTranscript = useCallback(
    (target = agent) =>
    {
      setOutput(target ? buildRestoredBlocks(target.getMessages()) : [])
      setScrollOffset(0)
    },
    [agent]
  )

  // show the model picker — preserves current agent for in-place switching
  // uses loadModelsRef to avoid circular dependency w/ loadModels/activateModel
  const loadModelsRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const modelLoadGenerationRef = useRef(0)
  const initialModelLoadStartedRef = useRef(false)
  const pickerSelectionPendingRef = useRef(false)
  const reopenModelPicker = useCallback(() =>
  {
    void loadModelsRef.current?.()
  }, [])

  const chooseModel = useCallback(
    (nextModel: string, restoredSession: typeof resumeSession) =>
    {
      if (pickerSelectionPendingRef.current) return
      pickerSelectionPendingRef.current = true
      setPickerState('hidden')
      void activateModel(nextModel, restoredSession)
        .then((result) =>
        {
          if (result.status === 'changed')
          {
            if (result.persistence.status === 'error')
            {
              setOutput((previous) => [
                ...previous,
                {
                  type: 'error' as const,
                  content:
                    'Model changed, but the current session could not be saved.',
                },
              ])
            }
            return
          }
          if (result.status === 'unchanged') return
          if (result.status === 'stale' || result.status === 'aborted') return

          pickerSelectionPendingRef.current = false
          setPickerErrorTitle('Failed to activate model')
          setPickerError('Another session update is still running.')
          setPickerState('error')
        })
        .catch((error: unknown) =>
        {
          if (!isAcceptingTransitions()) return
          pickerSelectionPendingRef.current = false
          setPickerErrorTitle('Failed to activate model')
          setPickerError(toErrorMessage(error))
          setPickerState('error')
        })
    },
    [activateModel, isAcceptingTransitions]
  )

  const loadModels = useCallback(async () =>
  {
    modelLoadAbortRef.current?.abort()
    const controller = new AbortController()
    modelLoadAbortRef.current = controller
    const loadGeneration = ++modelLoadGenerationRef.current
    pickerSelectionPendingRef.current = false
    setPickerState('loading')
    setPickerErrorTitle('Failed to load Ollama models')
    setPickerError('')

    try
    {
      const client = new OllamaClient(host)
      const loadedModels = sortModels(
        await client.listModels(controller.signal)
      )
      if (
        controller.signal.aborted ||
        loadGeneration !== modelLoadGenerationRef.current ||
        !isAcceptingTransitions()
      )
      {
        return
      }
      const isReopening = Boolean(agent)

      // when reopening mid-session, always show the picker — don't auto-select
      if (!isReopening)
      {
        if (loadedModels.length === 1)
        {
          chooseModel(loadedModels[0]!.name, resumeSession)
          return
        }

        if (resumeSession)
        {
          const sessionModel = loadedModels.find(
            (loadedModel) => loadedModel.name === resumeSession.meta.model
          )
          if (sessionModel)
          {
            chooseModel(sessionModel.name, resumeSession)
            return
          }
        }
      }

      // pre-select the current model in the picker list
      const currentModelIndex = isReopening
        ? loadedModels.findIndex((m) => m.name === agent?.getModel())
        : 0

      setModels(loadedModels)
      setSelectedModelIndex(currentModelIndex >= 0 ? currentModelIndex : 0)
      setPickerState('ready')
    }
    catch (err)
    {
      if (
        controller.signal.aborted ||
        loadGeneration !== modelLoadGenerationRef.current ||
        !isAcceptingTransitions()
      )
      {
        return
      }
      setPickerError(toErrorMessage(err))
      setPickerState('error')
    }
    finally
    {
      if (modelLoadAbortRef.current === controller)
      {
        modelLoadAbortRef.current = null
      }
    }
  }, [agent, chooseModel, host, isAcceptingTransitions, resumeSession])

  useEffect(() =>
  {
    loadModelsRef.current = loadModels
  }, [loadModels])

  useEffect(() => () => modelLoadAbortRef.current?.abort(), [])

  useEffect(() =>
  {
    modelLoadGenerationRef.current++
  }, [agent])

  useEffect(() =>
  {
    maxOffsetRef.current = maxOffset
  }, [maxOffset])

  useEffect(() =>
  {
    promptViewportRef.current = promptRender
      ? { maxOffset: promptRender.maxOffset, pageSize: promptRender.pageSize }
      : { maxOffset: 0, pageSize: 1 }
  }, [promptRender])

  // restart at the top whenever the prompt identity or width changes
  useEffect(() =>
  {
    queueMicrotask(() =>
    {
      setPromptScrollOffset(0)
    })
  }, [activePrompt, transcriptWidth])

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
    if (model || initialModelLoadStartedRef.current) return
    initialModelLoadStartedRef.current = true
    queueMicrotask(() =>
    {
      void loadModels()
    })
  }, [loadModels, model])

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

  useInput(
    (ch, key) =>
    {
      // scroll keys work inside every modal prompt viewport
      if (activePrompt)
      {
        const { maxOffset: promptMax, pageSize } = promptViewportRef.current
        const step = key.pageUp || key.pageDown ? pageSize : 1
        if (key.upArrow || key.pageUp)
        {
          setPromptScrollOffset((current) => Math.max(current - step, 0))
          return
        }
        if (key.downArrow || key.pageDown)
        {
          setPromptScrollOffset((current) =>
            Math.min(current + step, promptMax)
          )
          return
        }
      }

      if (activePrompt?.kind === 'mcp')
      {
        if ((key.ctrl && ch.toLowerCase() === 'c') || key.escape)
        {
          abortRun()
        }
        else if (ch === 'y' || ch === 'Y')
        {
          settlePrompt(activePrompt.id, true)
        }
        else if (ch === 'n' || ch === 'N')
        {
          settlePrompt(activePrompt.id, false)
        }

        return
      }

      if (activePrompt?.kind === 'tool')
      {
        if (key.ctrl && ch.toLowerCase() === 'c')
        {
          abortRun()
        }
        else if (ch === 'y' || ch === 'Y')
        {
          settlePrompt(activePrompt.id, true)
        }
        else if (ch === 'n' || ch === 'N' || key.escape)
        {
          settlePrompt(activePrompt.id, false)
        }

        return
      }

      if (activePrompt?.kind === 'doom')
      {
        if (key.ctrl && ch.toLowerCase() === 'c')
        {
          abortRun()
        }
        else if (ch === 'y' || ch === 'Y')
        {
          settlePrompt(activePrompt.id, true)
        }
        else if (ch === 'n' || ch === 'N' || key.escape)
        {
          settlePrompt(activePrompt.id, false)
        }

        return
      }

      if (pickerVisible)
      {
        // if there's an agent behind the picker, go back to chat; else exit
        const escapePicker = () =>
        {
          if (agent)
          {
            modelLoadAbortRef.current?.abort()
            modelLoadGenerationRef.current++
            setPickerState('hidden')
          }
          else
          {
            void shutdown()
          }
        }

        if (pickerState === 'loading')
        {
          if (key.escape)
          {
            escapePicker()
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
            escapePicker()
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
            chooseModel(
              selected.name,
              restoredSessionForPickerSelection(Boolean(agent), resumeSession)
            )
          }
        }
        else if (key.escape)
        {
          escapePicker()
        }
      }
    },
    {
      isActive: pickerVisible || Boolean(activePrompt),
    }
  )

  // slash-command list & project-file lookup for prompt autocomplete
  const completionCommands = useMemo(() => commandCompletions(), [])
  const paletteEntries = useMemo(
    () => buildPaletteEntries(commandInfos(), keybindingInfos()),
    []
  )
  const refreshFiles = useCallback(
    () => refreshProjectFiles(currentCwd),
    [currentCwd, refreshProjectFiles]
  )

  // single owner of the ask/yolo transition — no-op check, success/failure
  // output, & error containment for both ctrl+y & /permissions
  const setPermissionMode = useCallback(
    async (nextYolo: boolean, operation: OperationHandle<Agent>) =>
    {
      const result = await transitionPermissionMode(nextYolo, operation)
      if (result.status === 'unchanged')
      {
        if (!acceptsCommandEvent(operation)) return
        setOutput((prev) => [
          ...prev,
          {
            type: 'system' as const,
            content: formatPermissionModeUnchanged(nextYolo),
          },
        ])
        return
      }
      if (result.status === 'changed')
      {
        if (!acceptsCommandTerminal(operation)) return
        setOutput((prev) => [
          ...prev,
          {
            type: 'system' as const,
            content: formatPermissionModeChange(nextYolo),
          },
        ])
        return
      }
      if (result.status === 'error')
      {
        const acceptsResult = result.committed
          ? acceptsCommandTerminal(operation)
          : acceptsCommandEvent(operation)
        if (!acceptsResult) return
        setOutput((prev) => [
          ...prev,
          {
            type: 'error' as const,
            content: result.committed
              ? `Permission mode changed, but MCP cleanup failed: ${toErrorMessage(result.error)}`
              : `Failed to change permission mode: ${toErrorMessage(result.error)}`,
          },
        ])
      }
    },
    [acceptsCommandEvent, acceptsCommandTerminal, transitionPermissionMode]
  )

  const runSlashCommand = useCallback(
    async (value: string): Promise<SlashDispatchResult> =>
    {
      const commandOperation = beginOperation('command')
      if (!commandOperation) return { admitted: false, handled: false }
      const commandAgent = commandOperation.agent
      const acceptsCommand = () => acceptsCommandEvent(commandOperation)
      const acceptsTerminal = () => acceptsCommandTerminal(commandOperation)

      addHistoryEntry(value.trim(), getSessionId())

      setInput('')
      setScrollOffset(0)
      // lock submits for the command's lifetime so a long command (/index,
      // /compact, …) can't overlap w/ a chat turn or another command
      setCommandRunning(true)

      const cmdCtx: CommandContext = {
        agent: commandAgent,
        activeModel: commandAgent.getModel(),
        host,
        yolo: isYolo(),
        sessionLabelId: getSessionId(),
        signal: commandOperation.signal,
        getCwd: () => commandAgent.getCwd(),
        pushOutput: (...blocks) =>
        {
          if (acceptsCommand()) setOutput((prev) => [...prev, ...blocks])
        },
        pushTerminalOutput: (...blocks) =>
        {
          if (acceptsTerminal()) setOutput((prev) => [...prev, ...blocks])
        },
        clearSession: () =>
        {
          if (acceptsCommand()) clearSession()
        },
        rebuildTranscript: () =>
        {
          if (acceptsTerminal()) rebuildTranscript(commandAgent)
        },
        resetTokenUsage: () =>
        {
          if (acceptsTerminal()) resetTokenUsage()
        },
        reopenModelPicker: () =>
        {
          if (acceptsCommand()) reopenModelPicker()
        },
        switchModel: (nextModel) => switchModel(nextModel, commandOperation),
        setYolo: (nextYolo) => setPermissionMode(nextYolo, commandOperation),
        exitApp: () =>
        {
          if (acceptsCommand()) void shutdown()
        },
        resumeSession: (id) =>
          acceptsCommand() && resumeSessionById(id, commandOperation),
        saveCurrentSession: () => saveOperationSession(commandOperation),
        renameCurrentSession: (title) =>
          acceptsCommand() && renameCurrentSession(title),
        notifyThemeChanged: () =>
        {
          if (acceptsCommand()) setThemeGeneration(getThemeGeneration())
        },
      }

      return runOperation(commandOperation, async () =>
      {
        try
        {
          const handled = await dispatchCommand(value.trim(), cmdCtx)
          return { admitted: true, handled }
        }
        finally
        {
          finishCommand(commandOperation)
          setCommandRunning(false)
        }
      })
    },
    [
      acceptsCommandEvent,
      acceptsCommandTerminal,
      addHistoryEntry,
      beginOperation,
      clearSession,
      finishCommand,
      getSessionId,
      host,
      isYolo,
      rebuildTranscript,
      renameCurrentSession,
      reopenModelPicker,
      resetTokenUsage,
      resumeSessionById,
      runOperation,
      saveOperationSession,
      setPermissionMode,
      shutdown,
      switchModel,
    ]
  )

  const handleSubmit = useCallback(
    async (value: string) =>
    {
      if (
        !value.trim() ||
        runStage !== 'idle' ||
        promptActive ||
        commandRunning ||
        transitioningSession
      )
      {
        return
      }

      // intercept slash commands before sending to the agent
      let historyRecorded = false
      if (value.trim().startsWith('/'))
      {
        const result = await runSlashCommand(value.trim())
        if (!result.admitted || result.handled) return
        historyRecorded = true
      }

      const operation = beginOperation('turn')
      if (!operation) return
      const runAgent = operation.agent
      // accept the clean turn before runOperation's registered microtask so an
      // immediate cancel/shutdown cannot leave the visible & saved histories split
      const acceptedTurn = runAgent.acceptTurn({
        content: value,
        attachmentPaths: parseMentions(value),
      })
      const resetRunState = () =>
      {
        resetStreamBuffer()
        resetAnimation()
        setRunStage('idle')
        runStartTimeRef.current = null
        toolStartTimesRef.current.clear()
      }
      const completeFailedTurn = (message: string) =>
      {
        const completion = completeTurn(operation)
        if (!completion.accepted) return
        const pendingBlocks = consumeBufferedBlocks()
        const toolStarts = new Map(toolStartTimesRef.current)
        const finishedAt = Date.now()
        setOutput((prev) => [
          ...failPendingToolCalls(prev, toolStarts, finishedAt),
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
        if (!historyRecorded) addHistoryEntry(value.trim(), getSessionId())

        setInput('')
        setScrollOffset(0)
        setOutput((prev) => [...prev, { type: 'user', content: value }])
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
                setOutput((prev) => [
                  ...prev,
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

              setOutput((prev) => [
                ...prev,
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

              // compute the change preview before showing the box (best-effort)
              const preview = await previewToolDiff(name, args, {
                cwd: runAgent.getCwd(),
              })
              if (!acceptsEvent(operation)) return false

              return requestPrompt(operation, {
                kind: 'tool',
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
              stopWaiting()
              return requestPrompt(operation, { kind: 'mcp', request })
            },
            onDoomLoop(message)
            {
              if (!acceptsEvent(operation)) return Promise.resolve(false)
              stopWaiting()
              return requestPrompt(operation, { kind: 'doom', message })
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
              setOutput((prev) => [...prev, { type: 'system', content }])
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
                else if (diff)
                {
                  // the diff says it all — skip the redundant summary line
                  next.push({ type: 'diff', unified: diff } satisfies DiffBlock)
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
              if (!acceptsEvent(operation)) return
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
                lastPrefillTps:
                  prefillTps > 0 ? prefillTps : prev.lastPrefillTps,
                lastDecodeTps: decodeTps > 0 ? decodeTps : prev.lastDecodeTps,
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
              // rebuild from agent messages so the UI matches cleared undo stacks
              rebuildTranscript(runAgent)
              setOutput((prev) => [
                ...prev,
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
                setOutput((prev) => [
                  ...failPendingToolCalls(prev, toolStarts, finishedAt),
                  ...pendingBlocks,
                  { type: 'system', content: 'Generation interrupted' },
                  ...persistenceBlocks,
                ])
              }
              else
              {
                setOutput((prev) => [
                  ...prev,
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
      return task.catch((error: unknown) =>
      {
        completeFailedTurn(toErrorMessage(error))
      })
    },
    [
      addHistoryEntry,
      acceptsEvent,
      beginOperation,
      completeTurn,
      getSessionId,
      isYolo,
      promptActive,
      appendText,
      appendThinking,
      commandRunning,
      consumeBufferedBlocks,
      rebuildTranscript,
      resetAnimation,
      resetStreamBuffer,
      runStage,
      runSlashCommand,
      requestPrompt,
      runOperation,
      startWaiting,
      stopWaiting,
      transitioningSession,
    ]
  )

  const sessionLabel = sessionLabelId ? `session ${sessionLabelId}` : ''
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

  if (paletteVisible)
  {
    statusLine = buildStatusLine(
      'command palette',
      'enter runs · esc closes',
      transcriptWidth
    )
  }
  else if (pickerVisible)
  {
    statusLine =
      pickerState === 'loading'
        ? 'loading models from Ollama…'
        : pickerState === 'error'
          ? `press r to retry · ${pickerEscHint}`
          : `${models.length} models available · enter selects · ${pickerEscHint}`
  }
  else if (!agent || promptActive)
  {
    statusLine = ''
  }
  else if (scrollOffset > 0)
  {
    const stateLeft = isRunning
      ? describeRunStageWithElapsed(runStage, runElapsed, {
          prefix: 'scrollback',
          elapsedFallback: '0.0s',
        })
      : `scrollback · ${scrollOffset} lines above`
    const hintRight = isRunning
      ? 'ctrl+c interrupts · pgdn returns'
      : 'pgdn returns'
    statusLine = buildStatusLine(stateLeft, hintRight, transcriptWidth)
  }
  else if (isRunning)
  {
    const stageStr = describeRunStageWithElapsed(runStage, runElapsed)
    const stateLeft = [stageStr, tokenGauge, perfGauge]
      .filter(Boolean)
      .join(' · ')
    statusLine = buildStatusLine(
      stateLeft,
      'ctrl+c interrupts',
      transcriptWidth
    )
  }
  else if (sessionTransition)
  {
    const transitionLabel =
      sessionTransition.kind === 'model'
        ? sessionTransition.phase === 'precommit'
          ? 'switching model…'
          : 'finishing model update…'
        : sessionTransition.kind === 'permission'
          ? 'finishing permission update…'
          : 'finishing session update…'
    const transitionHint =
      sessionTransition.owner === 'command' &&
      sessionTransition.phase === 'precommit'
        ? 'ctrl+c interrupts'
        : sessionTransition.phase === 'committed_cleanup'
          ? 'cleanup in progress'
          : 'esc quits'
    statusLine = buildStatusLine(
      transitionLabel,
      transitionHint,
      transcriptWidth
    )
  }
  else if (commandRunning)
  {
    statusLine = buildStatusLine(
      'running command…',
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
    const hints = [yoloHint, 'ctrl+p commands', '/help', 'esc quits']
      .filter(Boolean)
      .join(' · ')
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
    if (!agent) return
    if (isRunning || commandRunning || transitioningSession || promptActive)
    {
      // deliberate: mid-run MCP enable/disable is unsafe, so say so instead
      // of silently swallowing the keypress
      setOutput((prev) => [
        ...prev,
        {
          type: 'system' as const,
          content: formatPermissionModeLocked(),
        },
      ])
      return
    }

    const operation = beginOperation('command')
    if (!operation) return
    setCommandRunning(true)
    void runOperation(operation, async () =>
    {
      try
      {
        await setPermissionMode(!isYolo(), operation)
      }
      finally
      {
        finishCommand(operation)
        setCommandRunning(false)
      }
    })
  }, [
    agent,
    beginOperation,
    commandRunning,
    finishCommand,
    isYolo,
    isRunning,
    promptActive,
    runOperation,
    setPermissionMode,
    transitioningSession,
  ])

  const openPalette = useCallback(() =>
  {
    if (
      !agent ||
      isRunning ||
      commandRunning ||
      transitioningSession ||
      promptActive
    )
    {
      return
    }
    setPaletteOpen(true)
  }, [agent, commandRunning, isRunning, promptActive, transitioningSession])

  const runKeybindingAction = useCallback(
    (action: KeybindingAction) =>
    {
      if (action === 'toggle-thinking')
      {
        onToggleThinking()
      }
      else if (action === 'toggle-permissions')
      {
        onTogglePermissions()
      }
      else if (action === 'page-up')
      {
        onPageUp()
      }
      else if (action === 'page-down')
      {
        onPageDown()
      }
    },
    [onPageDown, onPageUp, onTogglePermissions, onToggleThinking]
  )

  const onPaletteSelect = useCallback(
    (entry: PaletteEntry) =>
    {
      setPaletteOpen(false)
      if (entry.command)
      {
        void runSlashCommand(entry.command)
        return
      }
      if (entry.action)
      {
        runKeybindingAction(entry.action)
      }
    },
    [runKeybindingAction, runSlashCommand]
  )

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

  // escape or Ctrl+C aborts a running turn; when idle it exits
  const abortOrExit = useCallback(() =>
  {
    if (hasActiveOperation())
    {
      abortRun()
    }
    else
    {
      void shutdown()
    }
  }, [abortRun, hasActiveOperation, shutdown])

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
            <Text dimColor>ask</Text>
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
              <Text dimColor>{pluralize(messageCount, 'message')}</Text>
            </>
          )}
        </Text>
      </Box>

      <Text dimColor>{headerSep}</Text>

      {pickerVisible ? (
        <LineList lines={visiblePicker} />
      ) : paletteVisible ? (
        <CommandPalette
          entries={paletteEntries}
          width={transcriptWidth}
          height={paletteViewportHeight}
          onSelect={onPaletteSelect}
          onClose={() => setPaletteOpen(false)}
        />
      ) : agent ? (
        <LineList
          lines={output.length === 0 ? paddedWelcome : paddedTranscript}
        />
      ) : null}

      {!pickerVisible &&
        !paletteVisible &&
        agent &&
        !promptActive &&
        todoPanelLines.length > 0 && <LineList lines={todoPanelLines} dim />}

      {!pickerVisible && agent && promptActive && (
        <LineList lines={promptBoxLines} />
      )}

      {!pickerVisible && !paletteVisible && agent && !promptActive && (
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
              filesCacheKey={currentCwd}
              completionCommands={completionCommands}
              refreshFiles={refreshFiles}
              onChange={handleInputChange}
              onSubmit={handleSubmit}
              onEscape={abortOrExit}
              onInterrupt={abortOrExit}
              onPageUp={onPageUp}
              onPageDown={onPageDown}
              onScrollUp={onScrollUp}
              onScrollDown={onScrollDown}
              onToggleThinking={onToggleThinking}
              onTogglePermissions={onTogglePermissions}
              onOpenPalette={openPalette}
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
