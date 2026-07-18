// src/tui/App.tsx
// render the interactive terminal view and route user input

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import type { Agent } from '../agent/agent.js'
import { clamp } from '../utils/clamp.js'
import { pluralize } from '../utils/pluralize.js'
import { buildModelPickerLines } from './model/model-picker.js'
import { buildWelcomeLines } from './shell/welcome.js'
import {
  buildTranscriptLines,
  centerLinesVertical,
  maxScrollOffset,
  padLinesTop,
  sliceViewport,
} from './transcript/transcript.js'
import PromptInput from './prompt/prompt-input.js'
import CommandPalette from './palette/command-palette.js'
import { getThemeGeneration, inkColor, style } from './theme.js'
import { toErrorMessage } from '../utils/errors.js'
import {
  commandCompletions,
  commandInfos,
  dispatchCommand,
  keybindingInfos,
} from './commands/registry.js'
import type { CommandContext } from './commands/contracts.js'
import type { KeybindingAction } from './input/keybindings.js'
import { parseMentions } from './prompt/mentions.js'
import {
  formatPermissionModeChange,
  formatPermissionModeLocked,
  formatPermissionModeUnchanged,
} from './commands/runtime-output.js'
import { useInputHistory } from './prompt/use-input-history.js'
import {
  type InteractiveSessionView,
  useInteractiveSession,
} from './session/use-interactive-session.js'
import { resolveStartupSession } from './session/agent-session.js'
import { getCwd } from '../cwd.js'
import {
  buildTokenGauge,
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
  buildRule,
  buildStatusLine,
  describeRunStageWithElapsed,
} from './run/status-line.js'
import { LineList } from './components/line-list.js'
import { buildTodoPanel } from './transcript/todo-panel.js'
import { useModelPicker } from './model/use-model-picker.js'
import { buildPaletteEntries, type PaletteEntry } from './palette/palette.js'
import type { OperationHandle } from './session/interactive-runtime.js'
import { useAgentTurn } from './run/use-agent-turn.js'

export interface AppProps
{
  model?: string
  host: string
  think: boolean
  yolo: boolean
  resumeSessionId?: string
}

const SCROLL_LINES = 3

interface SlashDispatchResult
{
  admitted: boolean
  handled: boolean
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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [input, setInput] = useState('')
  const [showThinking, setShowThinking] = useState(true)
  // re-render when the module-level theme generation changes
  const [themeGeneration, setThemeGeneration] = useState(getThemeGeneration)
  // block new submits while a slash command or in-place model switch is running
  // so command and chat turns cannot overlap
  const [commandRunning, setCommandRunning] = useState(false)
  // body scroll position inside the active approval/confirm prompt
  const [promptScrollOffset, setPromptScrollOffset] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [terminalSize, setTerminalSize] = useState({
    columns: terminal.columns ?? 80,
    rows: terminal.rows ?? 24,
  })
  const previousLineCountRef = useRef(0)
  const {
    navigateUp,
    navigateDown,
    addEntry: addHistoryEntry,
    resetNavigation,
  } = useInputHistory()
  const clearInput = useCallback(() => setInput(''), [])
  const scrollToLatest = useCallback(() => setScrollOffset(0), [])
  const interactiveViewRef = useRef<InteractiveSessionView>({
    restoreSession()
    {},
    clearSession()
    {},
    resetTokenUsage()
    {},
  })
  const interactiveView = useMemo<InteractiveSessionView>(
    () => ({
      restoreSession: (session) =>
        interactiveViewRef.current.restoreSession(session),
      clearSession: () => interactiveViewRef.current.clearSession(),
      resetTokenUsage: () => interactiveViewRef.current.resetTokenUsage(),
    }),
    []
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
    acceptsCommandEvent,
    acceptsCommandTerminal,
    settlePrompt,
    finishCommand,
    runOperation,
    abortActive: abortRun,
    hasActiveOperation,
    getSessionId,
    isYolo,
    isAcceptingTransitions,
    shutdown: shutdownInteractive,
  } = interactive
  const {
    output,
    setOutput,
    runStage,
    runElapsed,
    tokenUsage,
    streamBuffer: streamBuf,
    spinnerTick,
    waitingElapsed,
    showWaitingIndicator,
    view: agentTurnView,
    rebuildTranscript,
    run: runAgentTurn,
    isRunning,
  } = useAgentTurn({
    initialSession: resumeSession,
    session: interactive,
    addHistoryEntry,
    clearInput,
    scrollToLatest,
  })
  useEffect(() =>
  {
    interactiveViewRef.current = agentTurnView
  }, [agentTurnView])

  const reportModelPersistenceError = useCallback(() =>
  {
    setOutput((previous) => [
      ...previous,
      {
        type: 'error',
        content: 'Model changed, but the current session could not be saved.',
      },
    ])
  }, [setOutput])
  const {
    state: pickerState,
    visible: pickerVisible,
    errorTitle: pickerErrorTitle,
    error: pickerError,
    models,
    selectedIndex: selectedModelIndex,
    reopen: reopenModelPicker,
    retry: retryModelPicker,
    moveSelection: moveModelSelection,
    selectCurrent: selectCurrentModel,
    escape: escapeModelPicker,
    shutdown,
  } = useModelPicker({
    requestedModel: model,
    host,
    initialSession: resumeSession,
    agent,
    activateModel,
    isAcceptingTransitions,
    shutdown: shutdownInteractive,
    onPersistenceError: reportModelPersistenceError,
  })
  const transitioningSession = sessionTransition !== null

  const maxOffsetRef = useRef(0)
  const chatViewportHeightRef = useRef(6)
  // prompt viewport geometry for the modal scroll keys
  const promptViewportRef = useRef({ maxOffset: 0, pageSize: 1 })
  const currentCwd = agent?.getCwd() ?? getCwd()
  const transcriptWidth = Math.max(terminalSize.columns - 2, 20)
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
        if (pickerState === 'loading')
        {
          if (key.escape) escapeModelPicker()
          return
        }

        if (pickerState === 'error')
        {
          if (ch === 'r' || ch === 'R')
          {
            retryModelPicker()
          }
          else if (key.escape)
          {
            escapeModelPicker()
          }

          return
        }

        if (key.upArrow || ch === 'k')
        {
          moveModelSelection(-1)
        }
        else if (key.downArrow || ch === 'j')
        {
          moveModelSelection(1)
        }
        else if (key.return)
        {
          selectCurrentModel()
        }
        else if (key.escape)
        {
          escapeModelPicker()
        }
      }
    },
    {
      isActive: pickerVisible || Boolean(activePrompt),
    }
  )

  // slash-command list and project-file lookup for prompt autocomplete
  const completionCommands = useMemo(() => commandCompletions(), [])
  const paletteEntries = useMemo(
    () => buildPaletteEntries(commandInfos(), keybindingInfos()),
    []
  )
  const refreshFiles = useCallback(
    () => refreshProjectFiles(currentCwd),
    [currentCwd, refreshProjectFiles]
  )

  // own the ask/yolo transition, including no-op handling, output, and errors
  // for ctrl+y and /permissions
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
    [
      acceptsCommandEvent,
      acceptsCommandTerminal,
      setOutput,
      transitionPermissionMode,
    ]
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
      // lock submits for the command's lifetime so /index and /compact cannot
      // overlap with a chat turn or another command
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
      setOutput,
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
      await runAgentTurn(value, {
        historyRecorded,
        attachmentPaths: parseMentions(value),
      })
    },
    [
      commandRunning,
      promptActive,
      runAgentTurn,
      runStage,
      runSlashCommand,
      transitioningSession,
    ]
  )

  const sessionLabel = sessionLabelId ? `session ${sessionLabelId}` : ''
  // ctx gauge reflects current context occupancy, not lifetime throughput
  const tokenGauge = buildTokenGauge(tokenUsage.context, contextWindow)
  // cumulative tokens processed this session — distinct from current occupancy
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
    // show the context gauge, last-turn throughput, and session total while idle
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
      // reject mid-run MCP enable/disable because the active Agent owns the
      // current tool set
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
    setOutput,
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
