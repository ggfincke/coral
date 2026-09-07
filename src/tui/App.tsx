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
import { formatBlocksPlain } from './transcript/plain.js'
import { toggleNewestToolResult } from './transcript/expansion.js'
import { runInExternalEditor } from './prompt/editor-handoff.js'
import { loadPrefs, savePrefs } from '../config/prefs.js'
import {
  buildBell,
  buildDesktopNotification,
  shouldNotifyFocusAware,
} from './shell/notify.js'
import {
  buildTerminalTitle,
  formatBlockedTitle,
  formatIdleTitle,
  formatRunningTitle,
} from './shell/title.js'
import { useTerminalModes } from './input/use-terminal-modes.js'

// queued-message rows shown above the composer before an overflow summary
const QUEUE_PREVIEW_ROWS = 3
import CommandPalette from './palette/command-palette.js'
import { getThemeGeneration, inkColor, style } from './theme.js'
import { physicalLines, truncateLine } from './wrap.js'
import {
  buildActivityLines,
  buildComposerRule,
  buildHeaderLine,
} from './shell/layout.js'
import { toErrorMessage } from '../utils/errors.js'
import {
  commandCompletions,
  commandInfos,
  dispatchCommand,
  keybindingInfos,
} from './commands/registry.js'
import type { CommandContext } from './commands/contracts.js'
import { runAdmittedCommand } from './commands/command-operation.js'
import {
  resolveKeybindingConfig,
  type KeybindingAction,
} from './input/keybindings.js'
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
import { buildMetricLines } from './shell/metrics.js'
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
import BacktrackSelector from './transcript/backtrack-selector.js'
import {
  buildBacktrackTurns,
  type BacktrackTurn,
} from './transcript/backtrack.js'
import { committedSaveWarning, systemBlock } from './commands/output.js'
import { useModelPicker } from './model/use-model-picker.js'
import SessionPicker from './sessions/picker.js'
import { buildPaletteEntries, type PaletteEntry } from './palette/palette.js'
import type { OperationHandle } from './session/interactive-runtime.js'
import { useAgentTurn } from './run/use-agent-turn.js'
import {
  dequeueOldestMessage,
  emptyMessageQueue,
  enqueueMessage,
  formatQueueLines,
  promoteNewestForEdit,
} from './run/message-queue.js'

export interface AppProps
{
  model?: string
  host: string
  think: boolean
  yolo: boolean
  resumeSessionId?: string
}

const SCROLL_LINES = 3
// warn once free context drops below this share of the pinned window
const CTX_LOW_RATIO = 0.8
// second escape inside this window opens the backtrack selector
const BACKTRACK_DOUBLE_ESC_MS = 700

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
  // /resume overlay: fuzzy saved-session picker with transcript previews
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  // esc-esc rewind selector over prior user prompts; idle-only
  const [backtrackOpen, setBacktrackOpen] = useState(false)
  const [backtrackArmed, setBacktrackArmed] = useState(false)
  const lastEscapeAtRef = useRef(0)
  const backtrackHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const [input, setInput] = useState('')
  const [promptHeight, setPromptHeight] = useState(1)
  // prompts typed while a run is active; drained as autosends at the boundary
  const [queued, setQueued] = useState(emptyMessageQueue)
  const [showThinking, setShowThinking] = useState(true)
  // raw scrollback: styled transcript replaced by a plain full-history dump
  const [rawMode, setRawModeState] = useState(false)
  const { focused: terminalFocused, suspendTerminal } = useTerminalModes({
    enableMouseTracking: !rawMode,
  })
  const rawModeRef = useRef(false)
  const setRawMode = useCallback((enabled?: boolean) =>
  {
    const next = enabled ?? !rawModeRef.current
    rawModeRef.current = next
    setRawModeState(next)
    return next
  }, [])
  // vi modal editing, persisted across sessions via prefs
  const [viMode, setViModeState] = useState(() => loadPrefs().vim === true)
  const setVimMode = useCallback((enabled: boolean) =>
  {
    savePrefs({ vim: enabled })
    setViModeState(enabled)
  }, [])
  // chord overrides resolve once per mount; /keybindings re-reads prefs live
  const chordOverrides = useMemo(() =>
  {
    return resolveKeybindingConfig(loadPrefs().keybindings).lookup
  }, [])
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
    getEntries: getHistoryEntries,
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

  // a queued prompt belongs to the conversation it was typed into; a session
  // switch invalidates the backlog instead of firing it at the new session
  const [queueBinding, setQueueBinding] = useState({
    agent,
    sessionId: sessionLabelId,
  })
  if (
    queueBinding.agent !== agent ||
    queueBinding.sessionId !== sessionLabelId
  )
  {
    setQueueBinding({ agent, sessionId: sessionLabelId })
    // assigning the first persisted id does not replace the conversation
    if (queueBinding.agent !== agent || queueBinding.sessionId !== null)
    {
      setQueued(emptyMessageQueue())
    }
  }
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
    stalled,
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
  const transcriptWidth = Math.max(terminalSize.columns - 2, 1)
  const sessionPickerVisible =
    sessionPickerOpen && !pickerVisible && Boolean(agent)
  const paletteVisible =
    paletteOpen && !pickerVisible && !sessionPickerVisible && Boolean(agent)

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
  const promptActive = Boolean(activePromptContent)
  const pickerOverlay =
    pickerVisible || paletteVisible || backtrackOpen || sessionPickerVisible
  const showComposer = Boolean(agent) && !pickerOverlay && !promptActive
  const metricLines = agent
    ? buildMetricLines(
        {
          decodeTps: tokenUsage.lastDecodeTps,
          prefillTps: tokenUsage.lastPrefillTps,
          contextTokens: tokenUsage.context,
          contextWindow,
          sessionTokens: tokenUsage.prompt + tokenUsage.completion,
        },
        transcriptWidth
      )
    : []
  const ctxLow =
    contextWindow > 0 && tokenUsage.context >= contextWindow * CTX_LOW_RATIO
  let activity = 'ready'
  let activityHint = ''
  if (paletteVisible)
  {
    activity = 'command palette'
    activityHint = 'enter runs · esc closes'
  }
  else if (backtrackOpen)
  {
    activity = 'backtrack'
    activityHint = 'enter restores · esc cancels'
  }
  else if (sessionPickerVisible)
  {
    activity = 'resume session'
    activityHint = 'enter resumes · esc cancels'
  }
  else if (pickerVisible)
  {
    activity =
      pickerState === 'loading'
        ? 'loading models from Ollama…'
        : pickerState === 'error'
          ? 'model unavailable'
          : `${models.length} models available`
    activityHint =
      pickerState === 'error'
        ? 'r retries · esc closes'
        : 'enter selects · esc closes'
  }
  else if (promptActive)
  {
    activity = style('warning')(
      `waiting for your approval${runElapsed ? ` · ${runElapsed}` : ''}`
    )
  }
  else if (scrollOffset > 0)
  {
    activity = isRunning
      ? describeRunStageWithElapsed(runStage, runElapsed, {
          prefix: 'scrollback',
          elapsedFallback: '0.0s',
        })
      : `scrollback · ${scrollOffset} lines above`
    activityHint = isRunning
      ? 'ctrl+c interrupts · pgdn returns'
      : 'pgdn returns'
  }
  else if (isRunning)
  {
    activity = describeRunStageWithElapsed(runStage, runElapsed)
    activityHint = 'ctrl+c interrupts'
  }
  else if (sessionTransition)
  {
    activity =
      sessionTransition.kind === 'model'
        ? sessionTransition.phase === 'precommit'
          ? 'switching model…'
          : 'finishing model update…'
        : sessionTransition.kind === 'permission'
          ? 'finishing permission update…'
          : 'finishing session update…'
    activityHint =
      sessionTransition.owner === 'command' &&
      sessionTransition.phase === 'precommit'
        ? 'ctrl+c interrupts'
        : sessionTransition.phase === 'committed_cleanup'
          ? 'cleanup in progress'
          : 'esc quits'
  }
  else if (commandRunning)
  {
    activity = 'running command…'
    activityHint = 'ctrl+c interrupts'
  }
  else if (backtrackArmed)
  {
    activityHint = 'esc again -> edit an earlier prompt'
  }
  if (stalled && isRunning)
  {
    activity += ` · ${style('warning')('no tokens')}`
  }
  if (ctxLow)
  {
    activity += ` · ${style('warning')('ctx low — /compact')}`
  }
  const activityLines = buildActivityLines(
    activity,
    activityHint,
    transcriptWidth
  )
  const headerHeight = 2
  const statusHeight = activityLines.length + metricLines.length
  const availableHeight = Math.max(
    terminalSize.rows - headerHeight - statusHeight,
    0
  )
  const approvalPinnedRows = activePromptContent
    ? physicalLines(
        activePromptContent.titleLines,
        Math.max(transcriptWidth - 4, 1)
      ).length +
      physicalLines(
        [activePromptContent.actionLine],
        Math.max(transcriptWidth - 4, 1)
      ).length +
      3
    : 0
  const terminalTooSmall =
    terminalSize.columns < 24 ||
    availableHeight <
      (promptActive ? approvalPinnedRows : pickerOverlay ? 4 : 5)
  // the editor budget does not depend on its reported height, avoiding a
  // render-measure feedback loop while hints and suggestions appear
  const queueCapacity = showComposer
    ? Math.max(availableHeight - 5 - 8 - 6, 0)
    : 0
  const queuePreviewCount = Math.min(
    queued.entries.length,
    QUEUE_PREVIEW_ROWS,
    Math.max(queueCapacity - 1, 0)
  )
  const queueLines =
    showComposer && queued.entries.length > 0 && queueCapacity > 0
      ? [
          style('muted')(
            truncateLine(
              `${queued.entries.length} queued · meta+backspace edits newest`,
              transcriptWidth
            )
          ),
          ...(queuePreviewCount > 0
            ? queued.entries.slice(-queuePreviewCount)
            : []
          ).map((entry) =>
            style('muted')(
              truncateLine(formatQueueLines([entry])[0] ?? '', transcriptWidth)
            )
          ),
        ]
      : []
  const composerChromeHeight = 3
  const promptMaxHeight = Math.max(
    Math.min(
      17,
      availableHeight - composerChromeHeight - queueLines.length - 6
    ),
    Math.min(
      2,
      Math.max(availableHeight - composerChromeHeight - queueLines.length, 0)
    )
  )
  const allocatedPromptHeight = Math.max(
    Math.min(promptHeight, promptMaxHeight),
    1
  )
  const inputHeight = showComposer
    ? Math.min(promptHeight, promptMaxHeight) +
      composerChromeHeight +
      queueLines.length
    : 0
  const maxPromptRows = Math.max(
    Math.min(
      availableHeight,
      Math.max(approvalPinnedRows, availableHeight - 6)
    ),
    0
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
  const approvalHeight = promptActive ? promptBoxLines.length : 0
  const todoBudget = showComposer
    ? Math.max(availableHeight - inputHeight - 6, 0)
    : 0
  const visibleTodoLines =
    todoPanelLines.length <= todoBudget
      ? todoPanelLines
      : todoPanelLines.length > 0 && todoBudget > 0
        ? [
            style('muted')(
              truncateLine(
                `tasks ${todos.filter((todo) => todo.status === 'completed').length}/${todos.length} · /todo`,
                transcriptWidth
              )
            ),
          ]
        : []
  const todoHeight = showComposer ? visibleTodoLines.length : 0
  const chatViewportHeight = Math.max(
    availableHeight - inputHeight - approvalHeight - todoHeight,
    0
  )
  const pickerViewportHeight = availableHeight
  const paletteViewportHeight = pickerViewportHeight
  const headerLine = buildHeaderLine({
    cwd: currentCwd,
    model: activeModel,
    yolo,
    width: transcriptWidth,
  })
  const headerSep = style('muted')(buildRule(transcriptWidth))
  const composerHint = truncateLine(
    isRunning
      ? `${viMode ? ':wq' : 'enter'} queues · ${
          queued.entries.length > 0 && queueLines.length === 0
            ? 'meta+backspace edits queued'
            : 'ctrl+g editor'
        }`
      : `${viMode ? ':wq' : 'enter'} sends · ctrl+g editor · ctrl+p commands · ctrl+c quit`,
    transcriptWidth
  )

  // expansion lives in a module-level WeakMap, so a tick forces the memoized
  // transcript to re-read it
  const [expansionTick, setExpansionTick] = useState(0)
  const onToggleToolOutput = useCallback(() =>
  {
    if (!toggleNewestToolResult(output)) return
    setExpansionTick((tick) => tick + 1)
  }, [output])

  const transcriptLines = useMemo(
    () =>
      buildTranscriptLines({
        cwd: currentCwd,
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
    // not read by the formatter: toggling mutates a module-level WeakMap, so
    // the tick exists purely to invalidate this memo
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      output,
      currentCwd,
      showThinking,
      showWaitingIndicator,
      spinnerTick,
      streamBuf,
      themeGeneration,
      transcriptWidth,
      waitingElapsed,
      expansionTick,
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

  // rewind targets come from conversation storage so indices line up with
  // messages; transcript blocks are a projection of these same turns
  const backtrackTurns = useMemo(
    () =>
      backtrackOpen && agent
        ? buildBacktrackTurns(agent.getMessages(), agent.getUndoStack())
        : [],
    [agent, backtrackOpen]
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
  const paddedWelcome = centerLinesVertical(
    welcomeLines.slice(0, chatViewportHeight),
    chatViewportHeight
  )

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

  // drop a pending backtrack arm hint on unmount
  useEffect(() =>
  {
    return () =>
    {
      if (backtrackHintTimerRef.current)
      {
        clearTimeout(backtrackHintTimerRef.current)
      }
    }
  }, [])

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
      if (terminalTooSmall)
      {
        if (key.ctrl && ch.toLowerCase() === 'c')
        {
          if (hasActiveOperation()) abortRun()
          else void shutdown()
        }
        return
      }
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
        else if (!key.ctrl && !key.meta && (ch === 'a' || ch === 'A'))
        {
          settlePrompt(activePrompt.id, { approved: true, always: true })
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
      isActive: terminalTooSmall || pickerVisible || Boolean(activePrompt),
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

      return runAdmittedCommand<SlashDispatchResult>(
        {
          run: (work) => runOperation(commandOperation, work),
          recordHistory: () => addHistoryEntry(value.trim(), getSessionId()),
          setRunning: setCommandRunning,
          finish: () => finishCommand(commandOperation),
          onError: (error) =>
          {
            if (acceptsTerminal())
            {
              setOutput((prev) => [
                ...prev,
                {
                  type: 'error',
                  content: `Command failed: ${toErrorMessage(error)}`,
                },
              ])
            }
            return { admitted: true, handled: true }
          },
        },
        async () =>
        {
          setInput('')
          setScrollOffset(0)

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
            switchModel: (nextModel) =>
              switchModel(nextModel, commandOperation),
            setYolo: (nextYolo) =>
              setPermissionMode(nextYolo, commandOperation),
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
            setRawMode,
            setVimMode,
            // /vim reads the live state back to toggle correctly
            isVimMode: () => viMode,
          }

          // bare /resume opens the picker inside the joined command lifetime
          if (value.trim() === '/resume')
          {
            setSessionPickerOpen(true)
            return { admitted: true, handled: true }
          }

          const handled = await dispatchCommand(value.trim(), cmdCtx)
          return { admitted: true, handled }
        }
      )
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
      setRawMode,
      setSessionPickerOpen,
      setVimMode,
      shutdown,
      switchModel,
      viMode,
    ]
  )

  // fork the conversation to just before a chosen turn; mirrors /undo's
  // canonical sequence: rebuildTranscript -> resetTokenUsage -> save
  const backtrackToTurn = useCallback(
    async (turn: BacktrackTurn) =>
    {
      setBacktrackOpen(false)
      lastEscapeAtRef.current = 0

      const operation = beginOperation('command')
      if (!operation) return
      const commandAgent = operation.agent

      await runOperation(operation, async () =>
      {
        try
        {
          const removedMessages = commandAgent.truncateToTurn(turn.startIndex)
          if (removedMessages === null)
          {
            if (acceptsCommandEvent(operation))
            {
              setOutput((prev) => [
                ...prev,
                systemBlock(
                  'Cannot backtrack after compaction or history changes'
                ),
              ])
            }
            return
          }

          rebuildTranscript(commandAgent)
          resetTokenUsage()
          const saved = saveOperationSession(operation)

          if (acceptsCommandTerminal(operation))
          {
            const warning = committedSaveWarning(saved, 'Backtrack completed')
            setOutput((prev) => [
              ...prev,
              systemBlock(
                `Backtracked ${pluralize(removedMessages, 'message')} — prompt restored to the composer`
              ),
              ...(warning ? [warning] : []),
            ])
          }

          resetNavigation()
          setInput(turn.content)
        }
        finally
        {
          finishCommand(operation)
        }
      })
    },
    [
      acceptsCommandEvent,
      acceptsCommandTerminal,
      beginOperation,
      finishCommand,
      rebuildTranscript,
      resetNavigation,
      resetTokenUsage,
      runOperation,
      saveOperationSession,
      setOutput,
    ]
  )

  const handleSubmit = useCallback(
    async (value: string) =>
    {
      const trimmed = value.trim()
      if (!trimmed || promptActive || commandRunning || transitioningSession)
      {
        return
      }

      // while a run is active, plain messages queue for autosend at the turn
      // boundary; slash commands stay interactive-only and are dropped
      if (runStage !== 'idle')
      {
        if (!trimmed.startsWith('/'))
        {
          const next = enqueueMessage(queued, trimmed)
          if (next === queued)
          {
            setOutput((prev) => [
              ...prev,
              systemBlock(
                'Message queue is full; the draft remains in the composer'
              ),
            ])
            return
          }
          setQueued(next)
          resetNavigation()
          setInput('')
        }
        return
      }

      // intercept slash commands before sending to the agent
      let historyRecorded = false
      if (trimmed.startsWith('/'))
      {
        const result = await runSlashCommand(trimmed)
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
      queued,
      resetNavigation,
      runAgentTurn,
      runStage,
      runSlashCommand,
      setOutput,
      transitioningSession,
    ]
  )
  // wait for the idle render before autosending; admission takes the same
  // runtime slot as a manual submit and keeps an unsubmitted draft intact
  useEffect(() =>
  {
    if (
      runStage !== 'idle' ||
      promptActive ||
      commandRunning ||
      transitioningSession ||
      queued.entries.length === 0
    )
    {
      return
    }
    let canceled = false
    queueMicrotask(() =>
    {
      if (canceled || hasActiveOperation() || !isAcceptingTransitions()) return
      const next = dequeueOldestMessage(queued)
      if (!next) return
      setQueued(next.state)
      void runAgentTurn(next.message.text, {
        historyRecorded: false,
        attachmentPaths: parseMentions(next.message.text),
        preserveInput: true,
      })
    })
    return () =>
    {
      canceled = true
    }
  }, [
    commandRunning,
    hasActiveOperation,
    isAcceptingTransitions,
    promptActive,
    queued,
    runAgentTurn,
    runStage,
    transitioningSession,
  ])

  // meta+backspace on an empty composer pulls the newest queued message back
  // for editing; returning false lets the normal word-kill proceed
  const handleQueueEdit = useCallback(() =>
  {
    const promoted = promoteNewestForEdit(queued)
    if (!promoted) return false

    setQueued(promoted.state)
    resetNavigation()
    setInput(promoted.message.text)
    return true
  }, [queued, resetNavigation])

  // terminal title mirrors activity state; written on stage changes only so
  // the braille frame stays static (animation would spam escape writes)
  const promptActiveForTitle = Boolean(activePromptContent)
  useEffect(() =>
  {
    const text = promptActiveForTitle
      ? formatBlockedTitle(currentCwd)
      : runStage === 'idle'
        ? formatIdleTitle(currentCwd)
        : formatRunningTitle(0, currentCwd)
    process.stdout.write(buildTerminalTitle(text))
  }, [currentCwd, promptActiveForTitle, runStage])

  // notify on completion or approval only while focus is absent or unknown
  const prevRunStageRef = useRef(runStage)
  const prevPromptActiveRef = useRef(promptActiveForTitle)
  useEffect(() =>
  {
    if (loadPrefs().notifications === false)
    {
      prevRunStageRef.current = runStage
      prevPromptActiveRef.current = promptActiveForTitle
      return
    }

    let message: string | null = null
    if (
      prevRunStageRef.current !== 'idle' &&
      runStage === 'idle' &&
      !promptActiveForTitle
    )
    {
      message = 'turn complete'
    }
    else if (!prevPromptActiveRef.current && promptActiveForTitle)
    {
      message = 'action required'
    }

    if (message && shouldNotifyFocusAware(terminalFocused, true))
    {
      process.stdout.write(
        buildBell() + buildDesktopNotification('coral', message)
      )
    }
    prevRunStageRef.current = runStage
    prevPromptActiveRef.current = promptActiveForTitle
  }, [promptActiveForTitle, runStage, terminalFocused])

  // raw-mode payload: whole committed transcript as plain text
  const rawDump = useMemo(
    () => (rawMode ? formatBlocksPlain(output).join('\n') : ''),
    [output, rawMode]
  )

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

  const onJumpTop = useCallback(() =>
  {
    setScrollOffset(maxOffsetRef.current)
  }, [])

  const onJumpBottom = useCallback(() => setScrollOffset(0), [])

  const onHalfPageUp = useCallback(() =>
  {
    setScrollOffset((current) =>
      clamp(
        current + Math.max(Math.floor(chatViewportHeightRef.current / 2), 1),
        0,
        maxOffsetRef.current
      )
    )
  }, [])

  const onHalfPageDown = useCallback(() =>
  {
    setScrollOffset((current) =>
      clamp(
        current - Math.max(Math.floor(chatViewportHeightRef.current / 2), 1),
        0,
        maxOffsetRef.current
      )
    )
  }, [])

  // ctrl+g shares terminal suspension with job control and restores the draft
  const handleOpenEditor = useCallback(async () =>
  {
    try
    {
      await suspendTerminal(async () =>
      {
        try
        {
          const outcome = await runInExternalEditor(input)
          if (outcome.text !== null && outcome.text !== input)
          {
            resetNavigation()
            setInput(outcome.text)
          }
        }
        catch
        {
          // editor missing or crashed: fall through w/ the draft intact
        }
      })
    }
    catch
    {
      // suspendTerminal unavailable in this Ink context; ignore the request
    }
  }, [input, resetNavigation, setInput, suspendTerminal])

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

  // Ctrl+C aborts a running turn; when idle it exits
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

  // composer escape keeps interrupt priority during runs; when idle the first
  // press arms esc-esc backtrack and a second press opens the rewind selector
  const handleComposerEscape = useCallback(() =>
  {
    if (hasActiveOperation())
    {
      abortRun()
      return
    }

    const now = Date.now()
    if (
      !agent ||
      rawModeRef.current ||
      commandRunning ||
      transitioningSession ||
      now - lastEscapeAtRef.current > BACKTRACK_DOUBLE_ESC_MS
    )
    {
      lastEscapeAtRef.current = now
      setBacktrackArmed(true)
      if (backtrackHintTimerRef.current)
      {
        clearTimeout(backtrackHintTimerRef.current)
      }
      backtrackHintTimerRef.current = setTimeout(() =>
      {
        backtrackHintTimerRef.current = null
        setBacktrackArmed(false)
      }, BACKTRACK_DOUBLE_ESC_MS)
      return
    }

    lastEscapeAtRef.current = 0
    if (backtrackHintTimerRef.current)
    {
      clearTimeout(backtrackHintTimerRef.current)
      backtrackHintTimerRef.current = null
    }
    setBacktrackArmed(false)
    setBacktrackOpen(true)
  }, [
    abortRun,
    agent,
    commandRunning,
    hasActiveOperation,
    transitioningSession,
  ])

  return (
    <Box
      flexDirection="column"
      width={Math.max(terminalSize.columns, 1)}
      height={rawMode ? undefined : Math.max(terminalSize.rows, 1)}
      paddingX={terminalSize.columns > 2 ? 1 : 0}
    >
      {terminalTooSmall && (
        <Text wrap="truncate-end" color={inkColor('warning')}>
          Resize terminal to show controls and stats
        </Text>
      )}
      <Box flexDirection="column" display={terminalTooSmall ? 'none' : 'flex'}>
        <LineList lines={[headerLine, headerSep]} />
        <Box
          flexDirection="column"
          height={
            rawMode && !pickerOverlay
              ? undefined
              : pickerOverlay
                ? pickerViewportHeight
                : chatViewportHeight
          }
          flexShrink={0}
          overflowY={rawMode ? undefined : 'hidden'}
        >
          {pickerVisible ? (
            <LineList lines={visiblePicker} />
          ) : paletteVisible ? (
            <CommandPalette
              active={!terminalTooSmall}
              entries={paletteEntries}
              width={transcriptWidth}
              height={paletteViewportHeight}
              onSelect={onPaletteSelect}
              onClose={() => setPaletteOpen(false)}
            />
          ) : backtrackOpen ? (
            <BacktrackSelector
              active={!terminalTooSmall}
              turns={backtrackTurns}
              width={transcriptWidth}
              height={paletteViewportHeight}
              onSelect={(turn) => void backtrackToTurn(turn)}
              onClose={() => setBacktrackOpen(false)}
            />
          ) : sessionPickerVisible ? (
            <SessionPicker
              active={!terminalTooSmall}
              width={transcriptWidth}
              height={paletteViewportHeight}
              onResume={(id) =>
                {
                // confirm routes through the /resume command so the transition
                // machinery (save -> resumeSessionById) stays the only path
                setSessionPickerOpen(false)
                void runSlashCommand(`/resume ${id}`)
              }}
              onClose={() => setSessionPickerOpen(false)}
            />
          ) : agent ? (
            rawMode ? (
              // native scrollback: the full plain dump renders once so terminal
              // selection behaves like ordinary output; no inline viewport math
              <Box flexDirection="column">
                <Text>{rawDump}</Text>
                <Text dimColor>
                  {' '}
                  {buildStatusLine(
                    'raw mode',
                    '/raw off returns to styled view',
                    transcriptWidth
                  )}
                </Text>
              </Box>
            ) : (
              <LineList
                lines={output.length === 0 ? paddedWelcome : paddedTranscript}
              />
            )
          ) : null}
        </Box>
        {showComposer && visibleTodoLines.length > 0 && (
          <LineList lines={visibleTodoLines} />
        )}

        {!pickerVisible && !sessionPickerVisible && agent && promptActive && (
          <LineList lines={promptBoxLines} />
        )}

        <LineList lines={activityLines} />
        <LineList lines={metricLines} />
        <Box flexDirection="column" display={showComposer ? 'flex' : 'none'}>
          <LineList lines={queueLines} />
          <LineList
            lines={[
              buildComposerRule(
                transcriptWidth,
                isRunning
                  ? `Queue follow-up${queued.entries.length ? ` · ${queued.entries.length} queued` : ''}`
                  : 'Message'
              ),
            ]}
          />
          <Box height={allocatedPromptHeight} flexShrink={0} overflowY="hidden">
            <Box width={4} flexShrink={0}>
              <LineList
                lines={Array.from(
                  {
                    length: allocatedPromptHeight,
                  },
                  (_, index) =>
                    style('muted')('│ ') +
                    (index === 0 ? style('user')('› ') : '  ')
                )}
              />
            </Box>
            <PromptInput
              width={Math.max(transcriptWidth - 6, 1)}
              maxHeight={promptMaxHeight}
              allocatedHeight={allocatedPromptHeight}
              onHeightChange={setPromptHeight}
              value={input}
              focus={
                !pickerVisible &&
                !paletteVisible &&
                !backtrackOpen &&
                !sessionPickerVisible &&
                Boolean(agent) &&
                !promptActive &&
                !terminalTooSmall
              }
              filesCacheKey={currentCwd}
              completionCommands={completionCommands}
              refreshFiles={refreshFiles}
              onChange={handleInputChange}
              onSubmit={handleSubmit}
              onEscape={handleComposerEscape}
              onInterrupt={abortOrExit}
              onPageUp={onPageUp}
              onPageDown={onPageDown}
              onJumpTop={onJumpTop}
              onJumpBottom={onJumpBottom}
              onHalfPageUp={onHalfPageUp}
              onHalfPageDown={onHalfPageDown}
              onToggleToolOutput={onToggleToolOutput}
              onOpenEditor={handleOpenEditor}
              viMode={viMode}
              chordOverrides={chordOverrides}
              onScrollUp={onScrollUp}
              onScrollDown={onScrollDown}
              onToggleThinking={onToggleThinking}
              onTogglePermissions={onTogglePermissions}
              onOpenPalette={openPalette}
              onHistoryUp={onHistoryUp}
              onHistoryDown={onHistoryDown}
              onQueueEdit={handleQueueEdit}
              getHistoryEntries={getHistoryEntries}
              placeholder={
                isRunning ? 'queue a follow-up' : 'ask coral anything'
              }
            />
            <Box width={2} flexShrink={0}>
              <LineList
                lines={Array.from(
                  {
                    length: allocatedPromptHeight,
                  },
                  () => style('muted')(' │')
                )}
              />
            </Box>
          </Box>
          <LineList
            lines={[
              style('muted')(
                `╰${buildRule(Math.max(transcriptWidth - 2, 0))}╯`
              ),
              style('muted')(composerHint),
            ]}
          />
        </Box>
      </Box>
    </Box>
  )
}
