// src/tui/session/interactive-runtime.ts
// coordinate Agent generations, operations, prompts, sessions, and cleanup

import type { ReliabilityStats } from '../../types/inference.js'
import type { SessionMeta } from '../../session/types.js'
import type { McpLaunchApprovalRequest } from '../../mcp/types.js'
import type { ToolCallPresentation } from '../../tools/tool.js'

export interface InteractiveLifetimeAgent
{
  dispose(): Promise<void>
  hasProducedTurn(): boolean
  getReliabilityTelemetry(): Array<{
    model: string
    stats: ReliabilityStats
  }>
}

export type ActivePrompt =
  | {
      id: number
      kind: 'tool'
      toolName: string
      args: Record<string, unknown>
      diff?: string
      previewMessage?: string
      presentation?: ToolCallPresentation
    }
  | {
      id: number
      kind: 'mcp'
      request: McpLaunchApprovalRequest
    }
  | {
      id: number
      kind: 'doom'
      message: string
    }

export type PromptRequest =
  | Omit<Extract<ActivePrompt, { kind: 'tool' }>, 'id'>
  | Omit<Extract<ActivePrompt, { kind: 'mcp' }>, 'id'>
  | Omit<Extract<ActivePrompt, { kind: 'doom' }>, 'id'>

export interface OperationHandle<A extends InteractiveLifetimeAgent>
{
  readonly id: number
  readonly generation: number
  readonly kind: 'turn' | 'command'
  readonly agent: A
  readonly signal: AbortSignal
}

export interface LifecycleTransition<A extends InteractiveLifetimeAgent>
{
  readonly id: number
  readonly kind: LifecycleTransitionKind
  readonly owner: OperationHandle<A> | null
  readonly signal: AbortSignal
}

export type LifecycleTransitionKind = 'model' | 'permission' | 'session'

export interface LifecycleTransitionSnapshot
{
  kind: LifecycleTransitionKind
  owner: 'command' | 'external'
  phase: 'precommit' | 'committed_cleanup'
}

export type LifecycleChangeResult =
  | { status: 'changed'; persistence?: SessionSaveResult }
  | { status: 'unchanged' }
  | { status: 'busy' }
  | { status: 'aborted' }
  | { status: 'stale' }

interface SessionBinding
{
  meta: SessionMeta | null
}

interface ActiveOperation<A extends InteractiveLifetimeAgent>
{
  handle: OperationHandle<A>
  controller: AbortController
  binding: SessionBinding
  phase: 'running' | 'aborting'
  handedOff: boolean
  task: Promise<void> | null
}

interface ActiveLifecycleTransition<A extends InteractiveLifetimeAgent>
{
  handle: LifecycleTransition<A>
  controller: AbortController
  phase: LifecycleTransitionSnapshot['phase']
  task: Promise<void> | null
}

interface PendingPrompt
{
  prompt: ActivePrompt
  settled: boolean
  resolve: (answer: boolean) => void
}

export interface InteractiveRuntimeDependencies<
  A extends InteractiveLifetimeAgent,
>
{
  persist: (agent: A, target: SessionMeta | null) => SessionMeta | null
  recordTelemetry: (model: string, stats: ReliabilityStats) => void
  onPromptChange: (prompt: ActivePrompt | null) => void
  onSessionChange: (meta: SessionMeta | null) => void
  onTransitionChange: (transition: LifecycleTransitionSnapshot | null) => void
}

export interface OperationCompletion
{
  accepted: boolean
  aborted: boolean
  session: SessionMeta | null
  persistence: 'saved' | 'error' | 'not_attempted'
}

export type SessionSaveResult =
  | { status: 'saved'; id: string }
  | { status: 'empty' }
  | { status: 'error' }
  | { status: 'stale' }

function cloneSessionMeta(meta: SessionMeta | null): SessionMeta | null
{
  return meta ? { ...meta } : null
}

// * owns the non-visual lifetime invariants shared by the TUI hook
export class InteractiveSessionRuntime<A extends InteractiveLifetimeAgent>
{
  private agent: A | null
  private generation = 0
  private nextOperationId = 1
  private nextPromptId = 1
  private nextTransitionId = 1
  private binding: SessionBinding
  private operation: ActiveOperation<A> | null = null
  private prompt: PendingPrompt | null = null
  private transition: ActiveLifecycleTransition<A> | null = null
  private readonly cleanups = new WeakMap<A, Promise<void>>()
  private readonly pendingCleanups = new Set<Promise<void>>()
  private readonly pendingOperationTasks = new Set<Promise<void>>()
  private closing = false
  private shutdownPromise?: Promise<void>

  constructor(
    private readonly dependencies: InteractiveRuntimeDependencies<A>,
    initialAgent: A | null,
    initialSession: SessionMeta | null
  )
  {
    this.agent = initialAgent
    if (initialAgent) this.generation = 1
    this.binding = this.createBinding(initialSession)
  }

  getAgent(): A | null
  {
    return this.agent
  }

  getGeneration(): number
  {
    return this.generation
  }

  getSessionMeta(): SessionMeta | null
  {
    return cloneSessionMeta(this.binding.meta)
  }

  getSessionId(): string | null
  {
    return this.binding.meta?.id ?? null
  }

  isClosing(): boolean
  {
    return this.closing
  }

  hasActiveOperation(): boolean
  {
    return this.operation !== null
  }

  hasActiveTransition(): boolean
  {
    return this.transition !== null
  }

  isCurrentAgent(agent: A, generation: number): boolean
  {
    return (
      !this.closing && this.agent === agent && this.generation === generation
    )
  }

  beginOperation(kind: 'turn' | 'command'): OperationHandle<A> | null
  {
    if (this.closing || !this.agent || this.operation || this.transition)
      return null

    const controller = new AbortController()
    const handle: OperationHandle<A> = Object.freeze({
      id: this.nextOperationId++,
      generation: this.generation,
      kind,
      agent: this.agent,
      signal: controller.signal,
    })
    this.operation = {
      handle,
      controller,
      binding: this.binding,
      phase: 'running',
      handedOff: false,
      task: null,
    }
    return handle
  }

  runOperation<T>(
    handle: OperationHandle<A>,
    work: () => Promise<T> | T
  ): Promise<T>
  {
    const active = this.operation
    if (this.closing || !active || active.handle !== handle || active.task)
    {
      return Promise.reject(new Error('Operation is no longer active'))
    }

    // install the join before invoking user code so /exit cannot start
    // shutdown in the gap between dispatch and task registration. an operation
    // that requests shutdown must not await its own joined shutdown promise
    const task = Promise.resolve().then(work)
    const joined = task.then(
      () => undefined,
      () => undefined
    )
    active.task = joined
    this.pendingOperationTasks.add(joined)
    const untrack = () => this.pendingOperationTasks.delete(joined)
    joined.then(untrack, untrack)
    return task
  }

  beginTransition(
    kind: LifecycleTransitionKind,
    owner?: OperationHandle<A>
  ): LifecycleTransition<A> | null
  {
    if (this.closing || this.transition) return null

    const operation = this.operation
    if (operation)
    {
      if (
        !owner ||
        operation.handle !== owner ||
        owner.kind !== 'command' ||
        operation.phase !== 'running' ||
        owner.signal.aborted ||
        !this.isCurrentAgent(owner.agent, owner.generation)
      )
      {
        return null
      }
    }
    else if (owner) return null

    const controller = new AbortController()
    const signal = owner
      ? AbortSignal.any([owner.signal, controller.signal])
      : controller.signal
    const handle = Object.freeze({
      id: this.nextTransitionId++,
      kind,
      owner: owner ?? null,
      signal,
    })
    this.transition = {
      handle,
      controller,
      phase: 'precommit',
      task: null,
    }
    this.publishTransition()
    return handle
  }

  markTransitionCommitted(transition: LifecycleTransition<A>): boolean
  {
    const active = this.transition
    if (!active || active.handle !== transition) return false
    if (active.phase === 'committed_cleanup') return true
    active.phase = 'committed_cleanup'
    this.publishTransition()
    return true
  }

  trackTransition<T>(
    transition: LifecycleTransition<A>,
    task: Promise<T>
  ): Promise<T>
  {
    const active = this.transition
    if (!active || active.handle !== transition)
    {
      return Promise.reject(
        new Error('Lifecycle transition is no longer active')
      )
    }
    if (active.task)
    {
      return Promise.reject(
        new Error('Lifecycle transition already has a task')
      )
    }

    const tracked = task.then(
      (value) =>
      {
        this.finishTransition(transition)
        return value
      },
      (error: unknown) =>
      {
        this.finishTransition(transition)
        throw error
      }
    )
    active.task = tracked.then(
      () => undefined,
      () => undefined
    )
    return tracked
  }

  finishTransition(transition: LifecycleTransition<A>): boolean
  {
    if (this.transition?.handle !== transition) return false
    this.transition = null
    this.dependencies.onTransitionChange(null)
    return true
  }

  acceptsEvent(handle: OperationHandle<A>): boolean
  {
    return (
      handle.kind === 'turn' &&
      this.operation?.handle === handle &&
      this.operation.phase === 'running' &&
      !handle.signal.aborted &&
      this.isCurrentAgent(handle.agent, handle.generation)
    )
  }

  acceptsCommandEvent(handle: OperationHandle<A>): boolean
  {
    const operation = this.operation
    return Boolean(
      handle.kind === 'command' &&
      operation?.handle === handle &&
      operation.phase === 'running' &&
      !handle.signal.aborted &&
      (operation.handedOff ||
        this.isCurrentAgent(handle.agent, handle.generation))
    )
  }

  acceptsCommandTerminal(handle: OperationHandle<A>): boolean
  {
    const operation = this.operation
    return Boolean(
      handle.kind === 'command' &&
      operation?.handle === handle &&
      (operation.handedOff ||
        (this.agent === handle.agent && this.generation === handle.generation))
    )
  }

  isCurrentOperation(handle: OperationHandle<A>): boolean
  {
    return (
      this.operation?.handle === handle &&
      this.isCurrentAgent(handle.agent, handle.generation)
    )
  }

  requestPrompt(
    handle: OperationHandle<A>,
    request: PromptRequest
  ): Promise<boolean>
  {
    if (!this.acceptsEvent(handle)) return Promise.resolve(false)

    this.settlePromptInternal(false)
    return new Promise<boolean>((resolve) =>
    {
      const prompt = { ...request, id: this.nextPromptId++ } as ActivePrompt
      this.prompt = {
        prompt,
        settled: false,
        resolve,
      }
      this.dependencies.onPromptChange(prompt)
    })
  }

  settlePrompt(promptId: number, answer: boolean): boolean
  {
    if (!this.prompt || this.prompt.prompt.id !== promptId) return false
    return this.settlePromptInternal(answer)
  }

  abortActive(): boolean
  {
    const active = this.operation
    if (!active || active.phase === 'aborting') return false

    active.phase = 'aborting'
    active.controller.abort()
    this.settlePromptInternal(false)
    return true
  }

  finishCommand(handle: OperationHandle<A>): boolean
  {
    if (handle.kind !== 'command' || this.operation?.handle !== handle)
      return false
    this.settlePromptInternal(false)
    this.operation = null
    return true
  }

  completeTurn(handle: OperationHandle<A>): OperationCompletion
  {
    const active = this.operation
    if (
      !active ||
      active.handle !== handle ||
      handle.kind !== 'turn' ||
      this.agent !== handle.agent ||
      this.generation !== handle.generation
    )
    {
      return {
        accepted: false,
        aborted: handle.signal.aborted,
        session: null,
        persistence: 'not_attempted',
      }
    }

    const aborted = active.phase === 'aborting' || handle.signal.aborted
    const initiatingBinding = active.binding
    this.settlePromptInternal(false)
    this.operation = null

    const persisted = this.persistToBinding(handle.agent, initiatingBinding)
    return {
      accepted: true,
      aborted,
      session: persisted,
      persistence: persisted ? 'saved' : 'error',
    }
  }

  saveCurrent(): SessionMeta | null
  {
    if (!this.agent || this.closing) return null
    return this.persistToBinding(this.agent, this.binding)
  }

  saveOperation(handle: OperationHandle<A>): SessionMeta | null
  {
    const active = this.operation
    if (!active || active.handle !== handle) return null
    if (handle.kind !== 'command' || !this.acceptsCommandTerminal(handle))
      return null
    return this.persistToBinding(handle.agent, active.binding)
  }

  replaceSession(meta: SessionMeta | null): void
  {
    this.binding = this.createBinding(meta)
    this.dependencies.onSessionChange(cloneSessionMeta(meta))
  }

  updateCurrentSession(meta: SessionMeta): void
  {
    this.binding.meta = cloneSessionMeta(meta)
    this.dependencies.onSessionChange(cloneSessionMeta(meta))
  }

  replaceAgent(
    nextAgent: A,
    session: SessionMeta | null,
    options: { preserveCommand?: boolean } = {}
  ): Promise<void>
  {
    if (this.closing)
    {
      return this.closeAgent(nextAgent)
    }

    const previous = this.agent
    this.retireOperation(options.preserveCommand === true)
    this.agent = nextAgent
    this.generation++
    this.replaceSession(session)

    if (!previous || previous === nextAgent) return Promise.resolve()
    return this.closeAgent(previous)
  }

  shutdown(): Promise<void>
  {
    this.shutdownPromise ??= this.shutdownInternal()
    return this.shutdownPromise
  }

  private async shutdownInternal(): Promise<void>
  {
    this.closing = true
    const operation = this.operation
    if (operation)
    {
      operation.phase = 'aborting'
      operation.controller.abort()
      this.settlePromptInternal(false)
    }
    const transition = this.transition
    transition?.controller.abort()
    if (transition && !transition.task)
    {
      this.finishTransition(transition.handle)
    }

    await Promise.all([
      ...(transition?.task ? [transition.task] : []),
      ...this.pendingOperationTasks,
    ])
    this.operation = null
    const current = this.agent
    this.agent = null
    this.generation++
    await this.closeAgent(current)

    await Promise.all([...this.pendingCleanups])
  }

  private createBinding(meta: SessionMeta | null): SessionBinding
  {
    return { meta: cloneSessionMeta(meta) }
  }

  private publishTransition(): void
  {
    const active = this.transition
    if (!active)
    {
      this.dependencies.onTransitionChange(null)
      return
    }
    this.dependencies.onTransitionChange({
      kind: active.handle.kind,
      owner: active.handle.owner ? 'command' : 'external',
      phase: active.phase,
    })
  }

  private persistToBinding(
    agent: A,
    binding: SessionBinding
  ): SessionMeta | null
  {
    const persisted = this.dependencies.persist(
      agent,
      cloneSessionMeta(binding.meta)
    )
    if (!persisted) return null

    binding.meta = cloneSessionMeta(persisted)
    if (this.binding === binding)
    {
      this.dependencies.onSessionChange(cloneSessionMeta(persisted))
    }
    return cloneSessionMeta(persisted)
  }

  private settlePromptInternal(answer: boolean): boolean
  {
    const pending = this.prompt
    if (!pending || pending.settled) return false

    pending.settled = true
    this.prompt = null
    this.dependencies.onPromptChange(null)
    pending.resolve(answer)
    return true
  }

  private retireOperation(preserveCommand: boolean): void
  {
    const active = this.operation
    if (!active) return

    this.settlePromptInternal(false)
    if (preserveCommand && active.handle.kind === 'command')
    {
      active.handedOff = true
      return
    }

    active.controller.abort()
    this.operation = null
  }

  private closeAgent(agent: A | null): Promise<void>
  {
    if (!agent) return Promise.resolve()
    const existing = this.cleanups.get(agent)
    if (existing) return existing

    const cleanup = (async () =>
    {
      await agent.dispose().catch(() => undefined)

      try
      {
        if (agent.hasProducedTurn())
        {
          for (const entry of agent.getReliabilityTelemetry())
          {
            this.dependencies.recordTelemetry(entry.model, entry.stats)
          }
        }
      }
      catch
      {
        // telemetry persistence is non-fatal
      }
    })()

    this.cleanups.set(agent, cleanup)
    this.pendingCleanups.add(cleanup)
    const untrack = () => this.pendingCleanups.delete(cleanup)
    cleanup.then(untrack, untrack)
    return cleanup
  }
}
