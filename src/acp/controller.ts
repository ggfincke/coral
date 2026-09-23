// src/acp/controller.ts
// own one ACP connection, one leased Coral session, and strict turn settlement

import { realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as acp from '@agentclientprotocol/sdk'
import { Agent } from '../agent/agent.js'
import type { AcceptedTurn, AgentEvents } from '../agent/contracts.js'
import { AgentTodoState } from '../agent/state/todos.js'
import type { McpConfigResolution } from '../config/mcp.js'
import { OllamaClient } from '../ollama/client.js'
import {
  InteractiveSessionRuntime,
  type InteractiveLifetimeAgent,
} from '../runtime/interactive-session.js'
import { SessionPersistenceError } from '../session/errors.js'
import {
  acquireSessionLease,
  createSessionRuntimeIdentity,
  type SessionLease,
} from '../session/lease.js'
import {
  createProviderSession,
  loadSession,
  retryProviderSessionSave,
  saveProviderSession,
  saveProviderSessionMetadata,
  type ProviderSessionMetadataSaveInput,
  type ProviderSessionSaveInput,
} from '../session/store.js'
import type {
  ProcessSessionRuntimeIdentity,
  SessionData,
} from '../session/types.js'
import { recordReliability } from '../telemetry/store.js'
import type { Model } from '../types/inference.js'
import type { UndoTurn } from '../types/undo.js'
import { toError } from '../utils/errors.js'
import { coralAcpError, invalidAcpParams, boundedDiagnostic } from './errors.js'
import { AcpEventProjection, AcpIdAllocator } from './events.js'
import {
  availableModelNames,
  buildModelConfigOption,
  DEFAULT_ACP_MODEL,
  selectedModelFromRequest,
} from './model-config.js'
import {
  buildProviderTurnSaveInput,
  type ProviderTurnSnapshotAgent,
} from './persistence.js'
import { normalizeAcpPrompt } from './prompt.js'
import {
  buildInteractionModes,
  buildRuntimeModeConfigOption,
  isRuntimeModeConfigRequest,
  selectedInteractionMode,
  selectedRuntimeMode,
} from './session-policy.js'
import type {
  CoralInteractionMode,
  CoralRuntimeMode,
} from './session-policy.js'

const require = createRequire(import.meta.url)
const { version: CORAL_VERSION } = require('../../package.json') as {
  version: string
}

export interface CoralAcpControllerOptions
{
  host: string
  model?: string
}

interface CoralAcpAgent
  extends InteractiveLifetimeAgent, ProviderTurnSnapshotAgent
  {
  acceptTurn(input: string): AcceptedTurn
  runAcceptedTurn(
    accepted: AcceptedTurn,
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void>
  switchModel(model: string, signal?: AbortSignal): Promise<void>
  restoreMessages(messages: SessionData['messages']): void
  restoreUndoStack(undo?: UndoTurn[], redo?: UndoTurn[]): void
  getFrozenPrefix(): { contextWindow: number }
}

interface CoralAcpControllerDependencies
{
  createAgent: (
    model: string,
    cwd: string,
    restored: SessionData | undefined,
    binding: {
      sessionId: string
      mcpConfig: McpConfigResolution
      runtimeMode: CoralRuntimeMode
      interactionMode: CoralInteractionMode
    }
  ) => CoralAcpAgent
  listModels: (signal?: AbortSignal) => Promise<Model[]>
  createRuntimeIdentity: () => ProcessSessionRuntimeIdentity
  acquireLease: typeof acquireSessionLease
  createSession: typeof createProviderSession
  loadSession: typeof loadSession
  saveTurn: typeof saveProviderSession
  retryTurn: typeof retryProviderSessionSave
  saveMetadata: typeof saveProviderSessionMetadata
  recordTelemetry: typeof recordReliability
}

type PendingWrite =
  | { kind: 'turn'; input: ProviderSessionSaveInput }
  | { kind: 'metadata'; input: ProviderSessionMetadataSaveInput }

interface BoundSession
{
  agent: CoralAcpAgent
  modelNames: string[]
  session: SessionData
  lease: SessionLease
  runtimeIdentity: ProcessSessionRuntimeIdentity
  runtime: InteractiveSessionRuntime<CoralAcpAgent>
  ids: AcpIdAllocator
  pendingWrite?: PendingWrite
  dirtyError?: Error
  activeTask?: Promise<unknown>
}

type ControllerPhase =
  'uninitialized' | 'ready_unbound' | 'binding' | 'bound' | 'closing' | 'closed'

function canonicalDirectory(path: string): string
{
  let canonical: string
  try
  {
    canonical = realpathSync(path)
  }
  catch
  {
    throw invalidAcpParams(`Working directory does not exist: ${path}`)
  }
  if (!statSync(canonical).isDirectory())
  {
    throw invalidAcpParams(`Working directory is not a directory: ${path}`)
  }
  return canonical
}

function assertBaselineSessionRequest(request: {
  additionalDirectories?: string[]
  mcpServers?: unknown[]
}): void
{
  if ((request.mcpServers?.length ?? 0) > 0)
    throw invalidAcpParams(
      'Client-supplied MCP servers are not supported by Coral ACP'
    )
  if ((request.additionalDirectories?.length ?? 0) > 0)
  {
    throw coralAcpError(
      'unsupported_capability',
      'Coral ACP does not support additional directories yet'
    )
  }
}

function persistenceRequestError(
  error: SessionPersistenceError
): acp.RequestError
{
  if (error.code === 'session_in_use')
  {
    return coralAcpError('session_in_use', error.message)
  }
  if (error.code === 'session_not_found')
  {
    return coralAcpError('session_not_found', error.message)
  }
  if (error.code === 'invalid_session')
  {
    return coralAcpError('invalid_session', error.message)
  }
  return coralAcpError(
    'session_persistence_failed',
    `Coral could not persist the session: ${boundedDiagnostic(error)}`
  )
}

function defaultCreateAgent(
  options: CoralAcpControllerOptions,
  model: string,
  cwd: string,
  restored: SessionData | undefined,
  binding: {
    sessionId: string
    mcpConfig: McpConfigResolution
    runtimeMode: CoralRuntimeMode
    interactionMode: CoralInteractionMode
  }
): CoralAcpAgent
{
  const agent = new Agent(model, options.host, cwd, {
    think: true,
    mcpMode: 'off',
    mcpConfig: binding.mcpConfig,
    todoState: new AgentTodoState(restored?.todos),
  })
  if (restored)
  {
    const currentSystem = agent.getMessages()[0]!
    const restoredTail =
      restored.messages[0]?.role === 'system'
        ? restored.messages.slice(1)
        : restored.messages
    agent.restoreMessages([currentSystem, ...restoredTail])
    agent.restoreUndoStack(restored.undo, restored.redo)
  }
  return agent
}

// * connection-scoped Coral ACP session authority
export class CoralAcpController
{
  private phase: ControllerPhase = 'uninitialized'
  private binding?: BoundSession
  private shutdownPromise?: Promise<void>
  private setupTask?: Promise<unknown>
  private readonly setupAbort = new AbortController()
  private readonly dependencies: CoralAcpControllerDependencies

  constructor(
    private readonly options: CoralAcpControllerOptions,
    dependencies: Partial<CoralAcpControllerDependencies> = {}
  )
  {
    const client = new OllamaClient(options.host)
    this.dependencies = {
      createAgent: (model, cwd, restored, binding) =>
        defaultCreateAgent(options, model, cwd, restored, binding),
      listModels: (signal) => client.listModels(signal),
      createRuntimeIdentity: createSessionRuntimeIdentity,
      acquireLease: acquireSessionLease,
      createSession: createProviderSession,
      loadSession,
      saveTurn: saveProviderSession,
      retryTurn: retryProviderSessionSave,
      saveMetadata: saveProviderSessionMetadata,
      recordTelemetry: recordReliability,
      ...dependencies,
    }
  }

  createApp(): acp.AgentApp
  {
    return acp
      .agent({ name: 'coral' })
      .onRequest(acp.methods.agent.initialize, () => this.initialize())
      .onRequest(acp.methods.agent.session.new, (context) =>
        this.runSetup(() =>
          this.newSession(
            context.params,
            AbortSignal.any([context.signal, this.setupAbort.signal])
          )
        )
      )
      .onRequest(acp.methods.agent.session.resume, (context) =>
        this.runSetup(() =>
          this.resumeSession(
            context.params,
            AbortSignal.any([context.signal, this.setupAbort.signal])
          )
        )
      )
      .onRequest(acp.methods.agent.session.prompt, (context) =>
        this.prompt(context.params, context.client, context.signal)
      )
      .onNotification(acp.methods.agent.session.cancel, (context) =>
        this.cancel(context.params)
      )
      .onRequest(acp.methods.agent.session.close, (context) =>
        this.close(context.params)
      )
      .onRequest(acp.methods.agent.session.setConfigOption, (context) =>
        this.setConfigOption(context.params, context.signal)
      )
      .onRequest(acp.methods.agent.session.setMode, (context) =>
        this.setMode(context.params, context.signal)
      )
  }

  private async runSetup<T>(start: () => Promise<T>): Promise<T>
  {
    if (this.setupTask)
      throw coralAcpError('session_busy', 'A session is being prepared')
    const task = start()
    this.setupTask = task
    try
    {
      return await task
    }
    finally
    {
      if (this.setupTask === task) this.setupTask = undefined
    }
  }

  private initialize(): acp.InitializeResponse
  {
    if (this.phase !== 'uninitialized')
    {
      throw coralAcpError('invalid_session', 'ACP is already initialized')
    }
    this.phase = 'ready_unbound'
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: {
        name: 'coral',
        title: 'Coral',
        version: CORAL_VERSION,
      },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
        mcpCapabilities: {},
        sessionCapabilities: {
          resume: {},
          close: {},
        },
      },
    }
  }

  private assertReadyUnbound(): void
  {
    if (this.phase === 'uninitialized')
    {
      throw coralAcpError('invalid_session', 'ACP is not initialized')
    }
    if (this.phase !== 'ready_unbound')
    {
      throw coralAcpError('session_busy', 'An ACP session is already bound')
    }
  }

  private requireBinding(sessionId: string): BoundSession
  {
    if (this.phase !== 'bound')
    {
      throw coralAcpError(
        'session_busy',
        this.phase === 'closing'
          ? 'The ACP session is closing'
          : 'No ACP session is currently bound'
      )
    }
    const binding = this.binding
    if (!binding || binding.session.meta.id !== sessionId)
    {
      throw coralAcpError(
        'session_not_bound',
        `Session ${sessionId} is not bound to this ACP connection`
      )
    }
    return binding
  }

  private async modelNames(signal?: AbortSignal): Promise<string[]>
  {
    const names = availableModelNames(
      await this.dependencies.listModels(signal)
    )
    if (names.length === 0)
    {
      throw coralAcpError(
        'invalid_session',
        'No Ollama models are installed for Coral'
      )
    }
    return names
  }

  private selectedNewModel(names: readonly string[]): string
  {
    const configured = this.options.model
    if (configured)
    {
      if (!names.includes(configured))
      {
        throw invalidAcpParams(`Unknown Ollama model: ${configured}`)
      }
      return configured
    }
    return names.includes(DEFAULT_ACP_MODEL) ? DEFAULT_ACP_MODEL : names[0]!
  }

  // ACP has no MCP capability, including user-configured servers
  private bindingMcpConfig(): McpConfigResolution
  {
    return { servers: [], issues: [] }
  }

  private configOptions(
    agent: CoralAcpAgent,
    names: readonly string[]
  ): acp.SessionConfigOption[]
  {
    return [
      buildModelConfigOption(agent.getModel(), names),
      buildRuntimeModeConfigOption('approval-required'),
    ]
  }

  private createBinding(
    session: SessionData,
    lease: SessionLease,
    runtimeIdentity: ProcessSessionRuntimeIdentity,
    mcpConfig: McpConfigResolution,
    modelNames: readonly string[]
  ): BoundSession
  {
    const agent = this.dependencies.createAgent(
      session.meta.model,
      session.meta.cwd,
      session,
      {
        sessionId: session.meta.id,
        mcpConfig,
        runtimeMode: 'approval-required',
        interactionMode: 'default',
      }
    )
    const holder: { binding?: BoundSession } = {}
    const runtime = new InteractiveSessionRuntime<CoralAcpAgent>(
      {
        persist: (targetAgent, target) =>
        {
          const binding = holder.binding
          if (!binding) throw new Error('ACP session binding is unavailable')
          if (targetAgent !== agent)
          {
            throw new Error('ACP runtime attempted to persist a retired Agent')
          }
          if (!binding.pendingWrite || binding.pendingWrite.kind !== 'turn')
          {
            throw new Error('ACP turn completed without a strict save input')
          }
          if (target?.id !== binding.session.meta.id)
          {
            throw new Error('ACP runtime session binding changed during save')
          }
          const saved = this.dependencies.saveTurn(binding.pendingWrite.input)
          binding.session = saved
          binding.pendingWrite = undefined
          binding.dirtyError = undefined
          return saved.meta
        },
        recordTelemetry: (model, stats) =>
          this.dependencies.recordTelemetry(model, stats),
        onPromptChange: () =>
        {},
        onSessionChange: (meta) =>
        {
          const binding = holder.binding
          if (!binding) return
          if (meta) binding.session = { ...binding.session, meta }
        },
        onTransitionChange: () =>
        {},
      },
      agent,
      session.meta
    )
    const binding: BoundSession = {
      agent,
      modelNames: [...modelNames],
      session,
      lease,
      runtimeIdentity,
      runtime,
      ids: new AcpIdAllocator(session.meta.id),
    }
    holder.binding = binding
    return binding
  }

  private bind(
    session: SessionData,
    lease: SessionLease,
    runtimeIdentity: ProcessSessionRuntimeIdentity,
    mcpConfig: McpConfigResolution,
    modelNames: readonly string[]
  ): BoundSession
  {
    const binding = this.createBinding(
      session,
      lease,
      runtimeIdentity,
      mcpConfig,
      modelNames
    )
    this.binding = binding
    this.phase = 'bound'
    return binding
  }

  private async newSession(
    request: acp.NewSessionRequest,
    signal: AbortSignal
  ): Promise<acp.NewSessionResponse>
  {
    try
    {
      this.assertReadyUnbound()
      this.phase = 'binding'
      assertBaselineSessionRequest(request)
      const cwd = canonicalDirectory(request.cwd)
      const mcpConfig = this.bindingMcpConfig()
      const names = await this.modelNames(signal)
      signal.throwIfAborted()
      const model = this.selectedNewModel(names)
      const runtimeIdentity = this.dependencies.createRuntimeIdentity()
      const created = this.dependencies.createSession({
        model,
        cwd,
        runtime: runtimeIdentity,
      })
      let binding: BoundSession | undefined
      try
      {
        binding = this.bind(
          created.session,
          created.lease,
          runtimeIdentity,
          mcpConfig,
          names
        )
      }
      catch (error)
      {
        if (binding && this.binding === binding)
        {
          try
          {
            await this.releaseBinding(binding)
          }
          finally
          {
            this.phase = 'ready_unbound'
          }
        }
        else await created.lease.release()
        throw error
      }
      if (!binding)
      {
        throw new Error('Coral ACP session binding was not created')
      }
      return {
        sessionId: binding.session.meta.id,
        modes: buildInteractionModes('default'),
        configOptions: this.configOptions(binding.agent, names),
      }
    }
    catch (error)
    {
      if (this.phase === 'binding') this.phase = 'ready_unbound'
      this.throwRequestError(error)
    }
  }

  private async resumeSession(
    request: acp.ResumeSessionRequest,
    signal: AbortSignal
  ): Promise<acp.ResumeSessionResponse>
  {
    try
    {
      this.assertReadyUnbound()
      this.phase = 'binding'
      assertBaselineSessionRequest(request)
      const cwd = canonicalDirectory(request.cwd)
      const mcpConfig = this.bindingMcpConfig()
      const initial = this.dependencies.loadSession(request.sessionId)
      if (!initial)
      {
        throw coralAcpError(
          'session_not_found',
          `Session ${request.sessionId} was not found or is corrupt`
        )
      }
      const storedCwd = canonicalDirectory(initial.meta.cwd)
      if (storedCwd !== cwd)
      {
        throw coralAcpError(
          'invalid_session',
          `Session ${request.sessionId} belongs to a different working directory`
        )
      }
      const names = await this.modelNames(signal)
      signal.throwIfAborted()
      const runtimeIdentity = this.dependencies.createRuntimeIdentity()
      const lease = this.dependencies.acquireLease(
        request.sessionId,
        runtimeIdentity
      )
      let resumed: SessionData
      try
      {
        const session = this.dependencies.loadSession(request.sessionId)
        if (!session || canonicalDirectory(session.meta.cwd) !== cwd)
        {
          throw coralAcpError(
            'invalid_session',
            `Session ${request.sessionId} changed while it was being resumed`
          )
        }
        resumed = this.dependencies.saveMetadata({
          sessionId: session.meta.id,
          lease,
          runtime: runtimeIdentity,
          model: session.meta.model,
          cwd: session.meta.cwd,
          metaHint: {
            createdAt: session.meta.createdAt,
            title: session.meta.title,
            compactionCount: session.meta.compactionCount,
            lastCompactedAt: session.meta.lastCompactedAt,
          },
        })
        this.bind(resumed, lease, runtimeIdentity, mcpConfig, names)
      }
      catch (error)
      {
        const binding = this.binding
        if (binding?.lease === lease)
        {
          try
          {
            await this.releaseBinding(binding)
          }
          finally
          {
            this.phase = 'ready_unbound'
          }
        }
        else await lease.release()
        throw error
      }
      return {
        modes: buildInteractionModes('default'),
        configOptions: this.configOptions(this.binding!.agent, names),
      }
    }
    catch (error)
    {
      if (this.phase === 'binding') this.phase = 'ready_unbound'
      this.throwRequestError(error)
    }
  }

  private recoverPendingWrite(binding: BoundSession): void
  {
    const pending = binding.pendingWrite
    if (!pending)
    {
      if (binding.dirtyError) throw binding.dirtyError
      return
    }
    try
    {
      const saved =
        pending.kind === 'turn'
          ? this.dependencies.retryTurn(pending.input)
          : this.dependencies.saveMetadata(pending.input)
      binding.session = saved
      binding.pendingWrite = undefined
      binding.dirtyError = undefined
      binding.runtime.updateCurrentSession(saved.meta)
    }
    catch (error)
    {
      binding.dirtyError = toError(error)
      throw error
    }
  }

  private async prompt(
    request: acp.PromptRequest,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<acp.PromptResponse>
  {
    let binding: BoundSession | undefined
    try
    {
      binding = this.requireBinding(request.sessionId)
      this.recoverPendingWrite(binding)
      if (binding.activeTask)
      {
        throw coralAcpError(
          'session_busy',
          'A Coral operation is already active'
        )
      }
      const prompt = normalizeAcpPrompt(request.prompt)
      const task = this.executePrompt(binding, prompt, client, signal)
      binding.activeTask = task
      try
      {
        return await task
      }
      finally
      {
        if (binding.activeTask === task) binding.activeTask = undefined
      }
    }
    catch (error)
    {
      this.throwRequestError(error)
    }
  }

  private async executePrompt(
    binding: BoundSession,
    prompt: string,
    client: acp.AgentContext,
    requestSignal: AbortSignal
  ): Promise<acp.PromptResponse>
  {
    const handle = binding.runtime.beginOperation('turn')
    if (!handle)
    {
      throw coralAcpError('session_busy', 'A Coral operation is already active')
    }
    const accepted = handle.agent.acceptTurn(prompt)
    const signal = AbortSignal.any([handle.signal, requestSignal])
    const projection = new AcpEventProjection(
      {
        sessionId: binding.session.meta.id,
        cwd: binding.session.meta.cwd,
        client,
        signal,
        isCurrent: () => binding.runtime.acceptsEvent(handle),
        getTodos: () => handle.agent.getTodos(),
        getContextWindow: () => handle.agent.getFrozenPrefix().contextWindow,
      },
      binding.ids
    )

    let failure: Error | undefined
    try
    {
      await binding.runtime.runOperation(handle, () =>
        handle.agent.runAcceptedTurn(accepted, projection.events(), signal)
      )
    }
    catch (error)
    {
      failure = toError(error)
    }

    let notificationError: Error | undefined
    try
    {
      await projection.drain()
    }
    catch (error)
    {
      notificationError = toError(error)
    }

    let saveInput: ProviderSessionSaveInput
    try
    {
      saveInput = buildProviderTurnSaveInput(
        handle.agent,
        binding.session,
        binding.lease
      )
    }
    catch (error)
    {
      binding.pendingWrite = undefined
      binding.dirtyError = toError(error)
      try
      {
        binding.runtime.completeTurn(handle)
      }
      catch
      {
        // preserve the original snapshot error as dirty-fault authority
      }
      throw error
    }
    binding.pendingWrite = { kind: 'turn', input: saveInput }
    try
    {
      const completion = binding.runtime.completeTurn(handle)
      if (!completion.accepted || completion.persistence !== 'saved')
      {
        throw new Error('Coral runtime did not settle the accepted turn')
      }
    }
    catch (error)
    {
      binding.dirtyError = toError(error)
      throw error
    }

    if (notificationError)
    {
      throw acp.RequestError.internalError(
        { code: 'session_update_failed' },
        boundedDiagnostic(notificationError)
      )
    }
    if (failure || projection.getAgentError())
      throw failure ?? projection.getAgentError()
    return {
      stopReason: signal.aborted
        ? 'cancelled'
        : projection.hitIterationLimit()
          ? 'max_turn_requests'
          : 'end_turn',
      ...(projection.getUsage() ? { usage: projection.getUsage() } : {}),
    }
  }

  private cancel(request: acp.CancelNotification): void
  {
    const binding = this.binding
    if (!binding || binding.session.meta.id !== request.sessionId) return
    binding.runtime.abortActive()
  }

  private async close(request: acp.CloseSessionRequest): Promise<void>
  {
    try
    {
      const binding = this.requireBinding(request.sessionId)
      this.phase = 'closing'
      binding.runtime.abortActive()
      await binding.activeTask?.catch(() => undefined)
      let persistenceError: Error | undefined
      try
      {
        this.recoverPendingWrite(binding)
      }
      catch (error)
      {
        persistenceError = toError(error)
      }
      try
      {
        await this.releaseBinding(binding)
      }
      finally
      {
        this.phase = 'ready_unbound'
      }
      if (persistenceError) throw persistenceError
    }
    catch (error)
    {
      this.throwRequestError(error)
    }
  }

  private async setConfigOption(
    request: acp.SetSessionConfigOptionRequest,
    requestSignal: AbortSignal
  ): Promise<acp.SetSessionConfigOptionResponse>
  {
    try
    {
      const binding = this.requireBinding(request.sessionId)
      this.recoverPendingWrite(binding)
      if (binding.activeTask)
      {
        throw coralAcpError(
          'session_busy',
          'Session configuration is available only while Coral is idle'
        )
      }
      const task = isRuntimeModeConfigRequest(request)
        ? this.executeSetRuntimeMode(binding, request, requestSignal)
        : this.executeSetConfigOption(binding, request, requestSignal)
      binding.activeTask = task
      try
      {
        return await task
      }
      finally
      {
        if (binding.activeTask === task) binding.activeTask = undefined
      }
    }
    catch (error)
    {
      return this.throwRequestError(error)
    }
  }

  private async executeSetConfigOption(
    binding: BoundSession,
    request: acp.SetSessionConfigOptionRequest,
    requestSignal: AbortSignal
  ): Promise<acp.SetSessionConfigOptionResponse>
  {
    const handle = binding.runtime.beginOperation('command')
    if (!handle)
    {
      throw coralAcpError(
        'session_busy',
        'Model configuration is available only while Coral is idle'
      )
    }
    const signal = AbortSignal.any([handle.signal, requestSignal])
    try
    {
      const configOptions = await binding.runtime.runOperation(
        handle,
        async () =>
        {
          const names = await this.modelNames(signal)
          const model = selectedModelFromRequest(request, names)
          await handle.agent.switchModel(model, signal)
          const input: ProviderSessionMetadataSaveInput = {
            sessionId: binding.session.meta.id,
            lease: binding.lease,
            runtime: binding.runtimeIdentity,
            model,
            cwd: handle.agent.getCwd(),
            metaHint: {
              createdAt: binding.session.meta.createdAt,
              title: binding.session.meta.title,
              compactionCount: handle.agent.getCompactionCount(),
              lastCompactedAt: handle.agent.getLastCompactedAt() ?? undefined,
            },
          }
          binding.pendingWrite = { kind: 'metadata', input }
          try
          {
            const saved = this.dependencies.saveMetadata(input)
            binding.session = saved
            binding.pendingWrite = undefined
            binding.dirtyError = undefined
            binding.runtime.updateCurrentSession(saved.meta)
            binding.modelNames = [...names]
          }
          catch (error)
          {
            binding.dirtyError = toError(error)
            throw error
          }
          return this.configOptions(handle.agent, names)
        }
      )
      return { configOptions }
    }
    finally
    {
      binding.runtime.finishCommand(handle)
    }
  }

  private async executeSetRuntimeMode(
    binding: BoundSession,
    request: acp.SetSessionConfigOptionRequest,
    requestSignal: AbortSignal
  ): Promise<acp.SetSessionConfigOptionResponse>
  {
    const handle = binding.runtime.beginOperation('command')
    if (!handle)
    {
      throw coralAcpError(
        'session_busy',
        'Session configuration is available only while Coral is idle'
      )
    }
    const signal = AbortSignal.any([handle.signal, requestSignal])
    try
    {
      return await binding.runtime.runOperation(handle, async () =>
      {
        signal.throwIfAborted()
        const mode = selectedRuntimeMode(request)
        void mode
        return {
          configOptions: this.configOptions(handle.agent, binding.modelNames),
        }
      })
    }
    finally
    {
      binding.runtime.finishCommand(handle)
    }
  }

  private async setMode(
    request: acp.SetSessionModeRequest,
    requestSignal: AbortSignal
  ): Promise<acp.SetSessionModeResponse>
  {
    let binding: BoundSession | undefined
    try
    {
      binding = this.requireBinding(request.sessionId)
      this.recoverPendingWrite(binding)
      if (binding.activeTask)
      {
        throw coralAcpError(
          'session_busy',
          'Session mode is available only while Coral is idle'
        )
      }
      const task = this.executeSetMode(binding, request, requestSignal)
      binding.activeTask = task
      try
      {
        return await task
      }
      finally
      {
        if (binding.activeTask === task) binding.activeTask = undefined
      }
    }
    catch (error)
    {
      return this.throwRequestError(error)
    }
  }

  private async executeSetMode(
    binding: BoundSession,
    request: acp.SetSessionModeRequest,
    requestSignal: AbortSignal
  ): Promise<acp.SetSessionModeResponse>
  {
    const handle = binding.runtime.beginOperation('command')
    if (!handle)
    {
      throw coralAcpError(
        'session_busy',
        'Session mode is available only while Coral is idle'
      )
    }
    const signal = AbortSignal.any([handle.signal, requestSignal])
    try
    {
      signal.throwIfAborted()
      selectedInteractionMode(request.modeId)
      return {}
    }
    finally
    {
      binding.runtime.finishCommand(handle)
    }
  }

  private async releaseBinding(binding: BoundSession): Promise<void>
  {
    if (this.binding === binding) this.binding = undefined
    let runtimeError: unknown
    try
    {
      await binding.runtime.shutdown()
    }
    catch (error)
    {
      runtimeError = error
    }

    try
    {
      await binding.lease.release()
    }
    catch (leaseError)
    {
      if (runtimeError)
      {
        throw new AggregateError(
          [runtimeError, leaseError],
          'ACP session runtime and lease cleanup failed'
        )
      }
      throw leaseError
    }
    if (runtimeError) throw runtimeError
  }

  shutdown(): Promise<void>
  {
    this.shutdownPromise ??= this.shutdownInternal()
    return this.shutdownPromise
  }

  private async shutdownInternal(): Promise<void>
  {
    if (this.phase === 'closed') return
    this.phase = 'closing'
    this.setupAbort.abort()
    await this.setupTask?.catch(() => undefined)
    const binding = this.binding
    let persistenceError: Error | undefined
    if (binding)
    {
      binding.runtime.abortActive()
      await binding.activeTask?.catch(() => undefined)
      try
      {
        this.recoverPendingWrite(binding)
      }
      catch (error)
      {
        persistenceError = toError(error)
      }
      try
      {
        await this.releaseBinding(binding)
      }
      finally
      {
        this.phase = 'closed'
      }
    }
    else this.phase = 'closed'
    if (persistenceError) throw persistenceError
  }

  private throwRequestError(error: unknown): never
  {
    if (error instanceof acp.RequestError) throw error
    if (error instanceof SessionPersistenceError)
    {
      throw persistenceRequestError(error)
    }
    throw acp.RequestError.internalError(
      { code: 'coral_internal_error' },
      boundedDiagnostic(error)
    )
  }
}
