// src/tui/session/use-interactive-session.ts
// own the interactive Agent, session, prompt, model, permission, and shutdown lifetime

import { existsSync } from 'node:fs'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Agent } from '../../agent/agent.js'
import { resolveMcpConfig } from '../../config/mcp.js'
import { OllamaClient } from '../../ollama/client.js'
import type { ActiveMcpMode } from '../../mcp/types.js'
import { loadSession, renameSession } from '../../session/store.js'
import type { SessionData, SessionMeta } from '../../session/types.js'
import { recordReliability } from '../../telemetry/store.js'
import type { TodoItem } from '../../types/todo.js'
import {
  createShutdownCoordinator,
  registerSignalHandlers,
} from '../shell/shutdown.js'
import {
  InteractiveSessionRuntime,
  type ActivePrompt,
  type LifecycleChangeResult,
  type LifecycleTransitionSnapshot,
  type OperationCompletion,
  type OperationHandle,
  type PromptRequest,
  type PromptSettlement,
  type SessionSaveResult,
  type ToolApprovalRequest,
} from './interactive-runtime.js'
import { ProjectFileCatalog } from './project-file-catalog.js'
import {
  buildPrimaryAgent,
  persistAgentSession,
  SessionTitleGenerator,
} from './agent-session.js'

export interface InteractiveSessionView
{
  restoreSession: (session: SessionData) => void
  clearSession: () => void
  resetTokenUsage: () => void
}

export interface UseInteractiveSessionOptions
{
  model?: string
  host: string
  think: boolean
  initialYolo: boolean
  initialSession: SessionData | null
  exit: () => void
  view: InteractiveSessionView
}

export type PermissionTransitionResult =
  | { status: 'changed' }
  | { status: 'unchanged' }
  | { status: 'busy' }
  | { status: 'aborted' }
  | { status: 'stale' }
  | { status: 'error'; error: unknown; committed: boolean }

export type ModelTransitionResult =
  | { status: 'changed'; persistence: SessionSaveResult }
  | Exclude<LifecycleChangeResult, { status: 'changed' }>

export interface InteractiveSession
{
  agent: Agent | null
  activeModel: string
  yolo: boolean
  contextWindow: number
  transition: LifecycleTransitionSnapshot | null
  activePrompt: ActivePrompt | null
  sessionLabelId: string | null
  todos: TodoItem[]
  listProjectFiles: (cwd: string) => Promise<string[]>
  refreshProjectFiles: (cwd: string) => Promise<string[]>
  invalidateProjectFiles: (cwd?: string) => void
  activateModel: (
    model: string,
    restored: SessionData | null
  ) => Promise<ModelTransitionResult>
  switchModel: (
    model: string,
    owner?: OperationHandle<Agent>
  ) => Promise<ModelTransitionResult>
  resumeSession: (id: string, owner?: OperationHandle<Agent>) => boolean
  saveOperationSession: (handle: OperationHandle<Agent>) => SessionSaveResult
  renameCurrentSession: (title: string) => boolean
  clearCurrentSession: () => void
  resetTokenUsage: () => void
  setPermissionMode: (
    yolo: boolean,
    owner?: OperationHandle<Agent>
  ) => Promise<PermissionTransitionResult>
  beginOperation: (kind: 'turn' | 'command') => OperationHandle<Agent> | null
  acceptsEvent: (handle: OperationHandle<Agent>) => boolean
  acceptsCommandEvent: (handle: OperationHandle<Agent>) => boolean
  acceptsCommandTerminal: (handle: OperationHandle<Agent>) => boolean
  isCurrentOperation: (handle: OperationHandle<Agent>) => boolean
  requestPrompt: (
    handle: OperationHandle<Agent>,
    prompt: PromptRequest
  ) => Promise<PromptSettlement>
  // grant-aware tool approval; consults & records session-scoped grants
  requestToolApproval: (
    handle: OperationHandle<Agent>,
    request: ToolApprovalRequest
  ) => Promise<boolean>
  settlePrompt: (id: number, settlement: PromptSettlement) => boolean
  completeTurn: (handle: OperationHandle<Agent>) => OperationCompletion
  finishCommand: (handle: OperationHandle<Agent>) => boolean
  runOperation: <T>(
    handle: OperationHandle<Agent>,
    work: () => Promise<T> | T
  ) => Promise<T>
  abortActive: () => boolean
  hasActiveOperation: () => boolean
  getSessionId: () => string | null
  isYolo: () => boolean
  isAcceptingTransitions: () => boolean
  shutdown: () => Promise<void>
}

function activeMcpMode(yolo: boolean): ActiveMcpMode
{
  return yolo ? 'yolo' : 'ask'
}

export function useInteractiveSession(
  options: UseInteractiveSessionOptions
): InteractiveSession
{
  const [mcpConfig] = useState(resolveMcpConfig)
  // one shared transport for every primary Agent this hook builds; the Agent
  // owns it, subagents inherit it, and background titles reuse the same one
  const [inferenceClient] = useState(() => new OllamaClient(options.host))
  const [initialAgent] = useState(() =>
  {
    if (!options.model) return null
    return buildPrimaryAgent({
      model: options.model,
      host: options.host,
      cwd: options.initialSession?.meta.cwd,
      think: options.think,
      mcpMode: activeMcpMode(options.initialYolo),
      mcpConfig,
      restored: options.initialSession,
      inferenceClient,
    })
  })
  const [agent, setAgent] = useState<Agent | null>(initialAgent)
  const [activeModel, setActiveModel] = useState(
    options.model ?? options.initialSession?.meta.model ?? ''
  )
  const [yolo, setYolo] = useState(options.initialYolo)
  const [contextWindow, setContextWindow] = useState(0)
  const [transition, setTransition] =
    useState<LifecycleTransitionSnapshot | null>(null)
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null)
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(
    options.initialSession?.meta ?? null
  )
  const [todos, setTodos] = useState<TodoItem[]>(initialAgent?.getTodos() ?? [])
  const yoloRef = useRef(yolo)
  const viewRef = useRef(options.view)
  const closingRef = useRef(false)
  const closeRuntimeRef = useRef<Promise<void> | null>(null)
  const [projectFileCatalog] = useState(() => new ProjectFileCatalog())

  const [runtime] = useState(
    () =>
      new InteractiveSessionRuntime<Agent>(
        {
          persist: persistAgentSession,
          recordTelemetry: (model, stats) => recordReliability(model, stats),
          onPromptChange: setActivePrompt,
          onSessionChange: setSessionMeta,
          onTransitionChange: setTransition,
        },
        initialAgent,
        options.initialSession?.meta ?? null
      )
  )

  // one-shot background titles ride the shared client; failures stay silent
  const [titleGenerator] = useState(
    () =>
      new SessionTitleGenerator({
        client: inferenceClient,
        isActiveSession: (id) => runtime.getSessionId() === id,
        applyTitle: (id, title) =>
        {
          const renamed = renameSession(id, title)
          if (renamed) runtime.updateCurrentSession(renamed)
        },
      })
  )

  const fetchContextWindow = useCallback(
    (target: Agent) =>
    {
      const generation = runtime.getGeneration()
      void target
        .fetchContextWindow()
        .then((size) =>
        {
          if (size > 0 && runtime.isCurrentAgent(target, generation))
          {
            setContextWindow(size)
          }
        })
        .catch(() => undefined)
    },
    [runtime]
  )

  const persistCurrent = useCallback((): SessionSaveResult =>
  {
    const current = runtime.getAgent()
    if (!current || closingRef.current || runtime.isClosing())
      return { status: 'stale' }
    if (current.getMessageCount() === 0 && !runtime.getSessionId())
      return { status: 'empty' }
    const saved = runtime.saveCurrent()
    return saved ? { status: 'saved', id: saved.id } : { status: 'error' }
  }, [runtime])

  const adoptAgent = useCallback(
    (
      createAgent: () => Agent,
      restored: SessionData | null,
      preserveCommand = false,
      owner?: OperationHandle<Agent>
    ): boolean =>
    {
      if (closingRef.current || runtime.isClosing()) return false
      const transition = runtime.beginTransition(
        restored ? 'session' : 'model',
        owner
      )
      if (!transition) return false
      void titleGenerator.cancel()

      let nextAgent: Agent
      try
      {
        nextAgent = createAgent()
      }
      catch (error)
      {
        runtime.finishTransition(transition)
        throw error
      }

      const previous = runtime.getAgent()
      if (previous && previous.getCwd() !== nextAgent.getCwd())
      {
        projectFileCatalog.invalidate()
      }
      const cleanup = runtime.replaceAgent(nextAgent, restored?.meta ?? null, {
        preserveCommand,
      })
      runtime.markTransitionCommitted(transition)
      const transitionTask =
        previous && previous !== nextAgent ? cleanup : Promise.resolve()
      void runtime
        .trackTransition(transition, transitionTask)
        .catch(() => undefined)
      setTodos(nextAgent.getTodos())
      setAgent(nextAgent)
      setActiveModel(nextAgent.getModel())
      setContextWindow(0)
      if (restored) viewRef.current.restoreSession(restored)
      fetchContextWindow(nextAgent)
      return true
    },
    [fetchContextWindow, projectFileCatalog, runtime, titleGenerator]
  )

  const switchModel = useCallback(
    (
      nextModel: string,
      owner?: OperationHandle<Agent>
    ): Promise<ModelTransitionResult> =>
    {
      if (owner && !runtime.acceptsCommandEvent(owner))
      {
        return Promise.resolve({
          status: owner.signal.aborted ? 'aborted' : 'stale',
        })
      }
      const target = runtime.getAgent()
      if (!target || closingRef.current || runtime.isClosing())
        return Promise.resolve({ status: 'stale' })
      if (target.getModel() === nextModel)
        return Promise.resolve({ status: 'unchanged' })

      const transition = runtime.beginTransition('model', owner)
      if (!transition)
      {
        return Promise.resolve({
          status: owner?.signal.aborted ? 'aborted' : 'busy',
        })
      }
      const generation = runtime.getGeneration()
      void titleGenerator.cancel()

      const task: Promise<ModelTransitionResult> = (async () =>
      {
        if (transition.signal.aborted) return { status: 'aborted' }
        try
        {
          await target.switchModel(nextModel, transition.signal)
        }
        catch (error)
        {
          if (transition.signal.aborted) return { status: 'aborted' }
          throw error
        }
        if (closingRef.current || !runtime.isCurrentAgent(target, generation))
        {
          return { status: 'stale' }
        }
        setActiveModel(nextModel)
        setContextWindow(0)
        runtime.markTransitionCommitted(transition)
        const persistence = persistCurrent()
        fetchContextWindow(target)
        return { status: 'changed', persistence }
      })()
      return runtime.trackTransition(transition, task)
    },
    [fetchContextWindow, persistCurrent, runtime, titleGenerator]
  )

  const activateModel = useCallback(
    (
      nextModel: string,
      restored: SessionData | null
    ): Promise<ModelTransitionResult> =>
    {
      const existing = runtime.getAgent()
      if (existing)
      {
        return switchModel(nextModel)
      }
      if (closingRef.current || runtime.isClosing())
        return Promise.resolve({ status: 'stale' })

      const adopted = adoptAgent(
        () =>
          buildPrimaryAgent({
            model: nextModel,
            host: options.host,
            cwd: restored?.meta.cwd,
            think: options.think,
            mcpMode: activeMcpMode(yoloRef.current),
            mcpConfig,
            restored,
            inferenceClient,
          }),
        restored
      )
      return Promise.resolve(
        adopted
          ? { status: 'changed', persistence: { status: 'empty' } }
          : { status: 'busy' }
      )
    },
    [
      adoptAgent,
      inferenceClient,
      mcpConfig,
      options.host,
      options.think,
      runtime,
      switchModel,
    ]
  )

  const renameCurrentSession = useCallback(
    (title: string): boolean =>
    {
      const current = runtime.getSessionMeta()
      if (!current) return false
      const renamed = renameSession(current.id, title)
      if (!renamed) return false
      runtime.updateCurrentSession(renamed)
      return true
    },
    [runtime]
  )

  const saveOperationSession = useCallback(
    (handle: OperationHandle<Agent>): SessionSaveResult =>
    {
      if (!runtime.acceptsCommandTerminal(handle)) return { status: 'stale' }
      if (handle.agent.getMessageCount() === 0 && !runtime.getSessionId())
        return { status: 'empty' }
      const saved = runtime.saveOperation(handle)
      return saved ? { status: 'saved', id: saved.id } : { status: 'error' }
    },
    [runtime]
  )

  const clearCurrentSession = useCallback(() =>
  {
    const current = runtime.getAgent()
    current?.clearTodos()
    current?.resetSessionMetrics()
    runtime.replaceSession(null)
    viewRef.current.clearSession()
  }, [runtime])

  const resetTokenUsage = useCallback(() =>
  {
    runtime.getAgent()?.resetTokenUsage()
    viewRef.current.resetTokenUsage()
  }, [runtime])

  const resumeSession = useCallback(
    (id: string, owner?: OperationHandle<Agent>): boolean =>
    {
      const target = loadSession(id)
      if (
        !target ||
        !existsSync(target.meta.cwd) ||
        closingRef.current ||
        runtime.isClosing()
      )
        return false

      return adoptAgent(
        () =>
          buildPrimaryAgent({
            model: target.meta.model,
            host: options.host,
            cwd: target.meta.cwd,
            think: options.think,
            mcpMode: activeMcpMode(yoloRef.current),
            mcpConfig,
            restored: target,
            inferenceClient,
          }),
        target,
        true,
        owner
      )
    },
    [
      adoptAgent,
      inferenceClient,
      mcpConfig,
      options.host,
      options.think,
      runtime,
    ]
  )

  const setPermissionMode = useCallback(
    (
      nextYolo: boolean,
      owner?: OperationHandle<Agent>
    ): Promise<PermissionTransitionResult> =>
    {
      if (owner && !runtime.acceptsCommandEvent(owner))
      {
        return Promise.resolve({
          status: owner.signal.aborted ? 'aborted' : 'stale',
        })
      }
      if (yoloRef.current === nextYolo)
        return Promise.resolve({ status: 'unchanged' })
      if (closingRef.current || runtime.isClosing())
        return Promise.resolve({ status: 'stale' })
      const target = runtime.getAgent()
      if (!target) return Promise.resolve({ status: 'stale' })

      const transition = runtime.beginTransition('permission', owner)
      if (!transition)
      {
        return Promise.resolve({
          status: owner?.signal.aborted ? 'aborted' : 'busy',
        })
      }
      const generation = runtime.getGeneration()

      const task: Promise<PermissionTransitionResult> = (async () =>
      {
        if (transition.signal.aborted) return { status: 'aborted' }
        let committed = false
        try
        {
          // publish the mode commit synchronously before returning its joined
          // cleanup promise; publish that commit immediately so cancellation
          // during retirement cannot split the runtime and visible mode
          const nextMcpMode = activeMcpMode(nextYolo)
          const cleanup = target.setMcpMode(nextMcpMode, transition.signal)
          committed = target.getMcpMode() === nextMcpMode
          if (committed)
          {
            runtime.markTransitionCommitted(transition)
            yoloRef.current = nextYolo
            setYolo(nextYolo)
          }
          await cleanup
          if (
            closingRef.current ||
            runtime.isClosing() ||
            !runtime.isCurrentAgent(target, generation)
          )
          {
            return { status: 'stale' }
          }
          if (committed) return { status: 'changed' }
          return transition.signal.aborted
            ? { status: 'aborted' }
            : { status: 'stale' }
        }
        catch (error)
        {
          if (transition.signal.aborted && !committed)
            return { status: 'aborted' }
          return { status: 'error', error, committed }
        }
      })()
      return runtime.trackTransition(transition, task)
    },
    [runtime]
  )

  const closeRuntime = useCallback((): Promise<void> =>
  {
    closingRef.current = true
    closeRuntimeRef.current ??= Promise.allSettled([
      titleGenerator.cancel(),
      runtime.shutdown(),
      projectFileCatalog.dispose(),
    ]).then((results) =>
    {
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })
    return closeRuntimeRef.current
  }, [projectFileCatalog, runtime, titleGenerator])

  const shutdownCoordinatorRef = useRef<(() => Promise<void>) | null>(null)
  const shutdown = useCallback(() =>
  {
    shutdownCoordinatorRef.current ??= createShutdownCoordinator(
      closeRuntime,
      options.exit
    )
    return shutdownCoordinatorRef.current()
  }, [closeRuntime, options.exit])

  useEffect(() =>
  {
    viewRef.current = options.view
  }, [options.view])

  useEffect(() =>
  {
    if (!agent) return

    const generation = runtime.getGeneration()
    return agent.subscribeTodos((nextTodos) =>
    {
      if (runtime.isCurrentAgent(agent, generation)) setTodos(nextTodos)
    })
  }, [agent, runtime])

  useEffect(() =>
  {
    if (agent && contextWindow === 0) fetchContextWindow(agent)
  }, [agent, contextWindow, fetchContextWindow])

  useEffect(() =>
  {
    const onSignal = () => void shutdown()
    return registerSignalHandlers(process, onSignal)
  }, [shutdown])

  useEffect(() =>
  {
    return () =>
    {
      void closeRuntime()
    }
  }, [closeRuntime])

  const beginOperation = useCallback(
    (kind: 'turn' | 'command') =>
    {
      const operation = runtime.beginOperation(kind)
      if (operation) void titleGenerator.cancel()
      return operation
    },
    [runtime, titleGenerator]
  )
  const acceptsEvent = useCallback(
    (handle: OperationHandle<Agent>) => runtime.acceptsEvent(handle),
    [runtime]
  )
  const acceptsCommandEvent = useCallback(
    (handle: OperationHandle<Agent>) => runtime.acceptsCommandEvent(handle),
    [runtime]
  )
  const acceptsCommandTerminal = useCallback(
    (handle: OperationHandle<Agent>) => runtime.acceptsCommandTerminal(handle),
    [runtime]
  )
  const isCurrentOperation = useCallback(
    (handle: OperationHandle<Agent>) => runtime.isCurrentOperation(handle),
    [runtime]
  )
  const requestPrompt = useCallback(
    (handle: OperationHandle<Agent>, prompt: PromptRequest) =>
      runtime.requestPrompt(handle, prompt),
    [runtime]
  )
  const requestToolApproval = useCallback(
    (handle: OperationHandle<Agent>, request: ToolApprovalRequest) =>
      runtime.requestToolApproval(handle, request),
    [runtime]
  )
  const settlePrompt = useCallback(
    (id: number, settlement: PromptSettlement) =>
      runtime.settlePrompt(id, settlement),
    [runtime]
  )
  const completeTurn = useCallback(
    (handle: OperationHandle<Agent>): OperationCompletion =>
    {
      const completion = runtime.completeTurn(handle)
      // a settled non-aborted turn may earn its background title; the offer is
      // fire-and-forget and can never affect the completion result
      if (completion.accepted && !completion.aborted && completion.session)
      {
        titleGenerator.offer(
          completion.session,
          handle.agent.getModel(),
          undefined,
          handle.agent.getFrozenPrefix().contextWindow
        )
      }
      return completion
    },
    [runtime, titleGenerator]
  )
  const finishCommand = useCallback(
    (handle: OperationHandle<Agent>) => runtime.finishCommand(handle),
    [runtime]
  )
  const runOperation = useCallback(
    <T>(
      handle: OperationHandle<Agent>,
      work: () => Promise<T> | T
    ): Promise<T> => runtime.runOperation(handle, work),
    [runtime]
  )
  const abortActive = useCallback(() => runtime.abortActive(), [runtime])
  const hasActiveOperation = useCallback(
    () => runtime.hasActiveOperation(),
    [runtime]
  )
  const getSessionId = useCallback(() => runtime.getSessionId(), [runtime])
  const isYolo = useCallback(() => yoloRef.current, [])
  const isAcceptingTransitions = useCallback(
    () =>
      !closingRef.current &&
      !runtime.isClosing() &&
      !runtime.hasActiveTransition(),
    [runtime]
  )
  const listProjectFiles = useCallback(
    (cwd: string) => projectFileCatalog.list(cwd),
    [projectFileCatalog]
  )
  const refreshProjectFiles = useCallback(
    (cwd: string) => projectFileCatalog.refresh(cwd),
    [projectFileCatalog]
  )
  const invalidateProjectFiles = useCallback(
    (cwd?: string) => projectFileCatalog.invalidate(cwd),
    [projectFileCatalog]
  )

  return {
    agent,
    activeModel,
    yolo,
    contextWindow,
    transition,
    activePrompt,
    sessionLabelId: sessionMeta?.id ?? null,
    todos,
    listProjectFiles,
    refreshProjectFiles,
    invalidateProjectFiles,
    activateModel,
    switchModel,
    resumeSession,
    saveOperationSession,
    renameCurrentSession,
    clearCurrentSession,
    resetTokenUsage,
    setPermissionMode,
    beginOperation,
    acceptsEvent,
    acceptsCommandEvent,
    acceptsCommandTerminal,
    isCurrentOperation,
    requestPrompt,
    requestToolApproval,
    settlePrompt,
    completeTurn,
    finishCommand,
    runOperation,
    abortActive,
    hasActiveOperation,
    getSessionId,
    isYolo,
    isAcceptingTransitions,
    shutdown,
  }
}
