// src/agent/agent.ts
// conversation loop and tool dispatch

import { OllamaClient } from '../ollama/client.js'
import type { AgentInferenceClient } from './inference-client.js'
import {
  makeReliabilityStats,
  type ModelRequestMessage,
  type OllamaMessage,
  type OllamaToolCall,
  type ReliabilityStats,
} from '../types/inference.js'
import { allTools, subagentTools } from '../tools/registry.js'
import { ToolCatalog } from '../tools/catalog.js'
import type { Tool } from '../tools/tool.js'
import { type SubagentResult, type SubagentRunner } from '../tools/subagent.js'
import { DEFAULT_OLLAMA_HOST } from '../ollama/host.js'
import { buildSystemPrompt } from './request/system-prompt.js'
import { projectContextBudgetForWindow } from './request/project-context.js'
import { setCwd, getCwd } from '../cwd.js'
import { resolve } from 'node:path'
import {
  resolvePermissions,
  type ToolPermissions,
} from '../config/permissions.js'
import {
  estimateMessageTokens,
  type CompactionConfig,
  type CompactionResult,
} from './state/compaction.js'
import {
  ConversationState,
  DEFAULT_MAX_HISTORY,
  type ConversationMessageAnchor,
} from './state/conversation.js'
import { MIN_NUM_CTX, resolvePinnedContextWindow } from '../config/context.js'
import { totalmem } from 'node:os'

export type { CompactionResult } from './state/compaction.js'
export type { AgentInferenceClient } from './inference-client.js'
export type { TurnInput } from './request/turn-context.js'
export type {
  AcceptedTurn,
  AgentEvents,
  AgentMcpManager,
  AgentMcpManagerFactory,
  AgentOptions,
  TokenUsage,
} from './contracts.js'
import { toError } from '../utils/errors.js'
import { raceAbort } from '../utils/abort.js'
import {
  parseToolCallsFromContent,
  STALL_NUDGE_MESSAGE,
  MAX_STALL_NUDGES,
  looksLikeAttemptedToolCall,
  REPROMPT_MESSAGE,
  MAX_REPROMPTS,
} from './loop/response-repair.js'
import {
  DoomLoopDetector,
  describeDoomLoop,
  type DoomLoopTrip,
} from './loop/doom-loop.js'
import {
  buildVerifyPrompt,
  buildVerifyReprompt,
  parseVerifyVerdict,
  MAX_VERIFY_REPROMPTS,
  type VerificationResult,
} from './loop/edit-verification.js'
import type {
  UndoFileChange,
  UndoResult,
  UndoTodoChange,
  UndoTurn,
} from '../types/undo.js'
import {
  cloneTodoItems,
  type TodoItem,
  type TodoListener,
  type TodoState,
} from '../types/todo.js'
import { ReplayCoordinator } from './effects/replay.js'
import {
  CompactionCoordinator,
  type CompactionCallbacks,
  type CompactionRuntime,
} from './loop/compactor.js'
import {
  RequestPlanner,
  type PreparedModelRequest,
} from './loop/request-planner.js'
import {
  ToolRoundExecutor,
  type ToolResultRoundAllowance,
} from './loop/tool-round.js'
import { McpToolScope } from './mcp-scope.js'
import { resolveVerifyConfig } from '../config/verify.js'
import {
  appendAttachmentContext,
  attachmentReportFromMaterialization,
} from './request/attachments.js'
import {
  TurnContextAssembler,
  type CapturedTurn,
  type TurnInput,
} from './request/turn-context.js'
import { TypeScriptCodeIntel } from '../lsp/client.js'
import type { CodeIntelService } from '../lsp/contracts.js'
import { AgentTodoState } from './state/todos.js'
import type { McpStatus } from '../mcp/types.js'
import {
  assertRequestBudget,
  requestBudgetCapacity,
  type RequestBudgetBreakdown,
} from './request/budget.js'
import {
  estimateModelRequestMessageDeltaTokens,
  toModelRequestMessage,
} from './request/projection.js'
import type { AcceptedTurn, AgentEvents, AgentOptions } from './contracts.js'

// cap tool-call rounds for research subagents
const SUBAGENT_MAX_ITERATIONS = 24

function mergeReliabilityStats(
  base: ReliabilityStats | undefined,
  add: ReliabilityStats
): ReliabilityStats
{
  const merged = makeReliabilityStats()
  for (const key of Object.keys(merged) as (keyof ReliabilityStats)[])
  {
    merged[key] = (base?.[key] ?? 0) + add[key]
  }
  return merged
}

interface TodoChangeTracker
{
  before: TodoItem[] | null
  after: TodoItem[] | null
}

// merge streamed tool-call chunks into a stable ordered list
function mergeToolCalls(
  existing: OllamaToolCall[],
  incoming: OllamaToolCall[]
): OllamaToolCall[]
{
  const merged = [...existing]

  for (const call of incoming)
  {
    const index = call.function.index

    if (typeof index === 'number')
    {
      const existingIndex = merged.findIndex(
        (candidate) => candidate.function.index === index
      )

      if (existingIndex === -1)
      {
        merged.push(call)
      }
      else
      {
        merged[existingIndex] = call
      }

      continue
    }

    merged.push(call)
  }

  return merged.sort((a, b) =>
  {
    const left = a.function.index
    const right = b.function.index

    if (typeof left === 'number' && typeof right === 'number')
    {
      return left - right
    }
    if (typeof left === 'number') return -1
    if (typeof right === 'number') return 1
    return 0
  })
}

function finalizedTodoChange(
  change: TodoChangeTracker
): UndoTodoChange | undefined
{
  if (!change.before || !change.after) return undefined
  return {
    before: cloneTodoItems(change.before),
    after: cloneTodoItems(change.after),
  }
}

interface ActiveAcceptedTurn
{
  handle: AcceptedTurn
  anchor: ConversationMessageAnchor
  running: boolean
}

// * Conversation agent with tool dispatch
export class Agent
{
  private client: AgentInferenceClient
  private state!: ConversationState
  private model: string
  private baseUrl?: string
  private cwd: string
  private permissions: ToolPermissions
  private thinkMode: boolean | 'low' | 'medium' | 'high'
  // keep the instance toolset and Ollama schema separate for restricted subagents
  private baseTools: readonly Tool[]
  // derive lookup, schemas, names, and token cost from one immutable profile
  private toolCatalog!: ToolCatalog
  private maxIterations?: number
  // hold options.num_ctx constant so Ollama does not reload the runner per session
  private numCtx = 0
  // share one in-flight context-window resolution and clear it after settlement
  private contextWindowPromise?: Promise<number>
  private contextResolutionAbort?: AbortController
  private totalPromptTokens = 0
  private totalCompletionTokens = 0
  private totalPromptEvalDurationNs = 0
  private totalEvalDurationNs = 0
  private contextWindowSize = 0
  private lastRequestBudget?: RequestBudgetBreakdown
  private reliabilityStats: ReliabilityStats = makeReliabilityStats()
  private telemetryStatsByModel = new Map<string, ReliabilityStats>()
  private producedModels = new Set<string>()
  private readonly todoState: TodoState
  private readonly turnContext: TurnContextAssembler
  private readonly replay: ReplayCoordinator
  private readonly compactor: CompactionCoordinator
  private readonly requestPlanner = new RequestPlanner()
  private readonly toolRounds: ToolRoundExecutor
  private acceptedTurn?: ActiveAcceptedTurn
  // self-check edits after a clean completion (warn-only); off by default
  private verifyEdits: boolean
  private subagentRunner: SubagentRunner
  private codeIntel: CodeIntelService
  private ownsCodeIntel: boolean
  private readonly lifecycleAbort = new AbortController()
  private readonly mcpScope: McpToolScope
  private readonly activeRuns = new Set<Promise<void>>()
  private disposePromise?: Promise<void>

  constructor(
    model: string,
    baseUrl?: string,
    cwd?: string,
    options: AgentOptions = {}
  )
  {
    this.model = model
    this.baseUrl = baseUrl
    this.cwd = resolve(cwd ?? getCwd())
    this.client = options.inferenceClient ?? new OllamaClient(baseUrl)
    this.thinkMode = options.think ?? true
    this.baseTools = options.tools ?? allTools
    this.wireToolCatalog()
    this.maxIterations = options.maxIterations
    this.verifyEdits =
      options.verifyEdits ?? resolveVerifyConfig(this.cwd).enabled
    this.codeIntel = options.codeIntel ?? new TypeScriptCodeIntel(this.cwd)
    this.ownsCodeIntel = options.codeIntel === undefined
    this.todoState = options.todoState ?? new AgentTodoState()
    this.turnContext = new TurnContextAssembler(this.cwd, options.turnContext)

    // keep the interactive default in sync with explicitly selected sessions
    if (cwd) setCwd(this.cwd)

    // load per-tool policies unless a caller injects them
    this.permissions = options.permissions ?? resolvePermissions(this.cwd)
    // defer manager construction so no-MCP sessions do not load the SDK graph
    this.mcpScope = new McpToolScope({
      enabled: Boolean(options.mcp),
      config: options.mcpConfig,
      permissions: this.permissions,
      baseTools: this.baseTools,
      managerFactory: options.mcpManagerFactory,
      lifecycleSignal: this.lifecycleAbort.signal,
    })

    // inherit a parent's pinned context window so shared-model subagents preserve the KV cache
    if (options.numCtx && options.numCtx > 0)
    {
      this.numCtx = options.numCtx
      this.contextWindowSize = options.numCtx
    }

    const systemContent = this.buildSystemContent(model)
    this.state = new ConversationState(systemContent)
    this.replay = new ReplayCoordinator(this.state, this.todoState, this.cwd)
    this.compactor = new CompactionCoordinator(this.state, this.client)
    if (options.numCtx && options.numCtx > 0)
    {
      this.compactor.setPromptLimit(
        requestBudgetCapacity(options.numCtx).promptLimit
      )
    }

    this.subagentRunner =
      options.readOnlySubagentRunner ??
      ((prompt, signal) => this.runReadOnlySubagent(prompt, signal))
    this.toolRounds = new ToolRoundExecutor({
      cwd: this.cwd,
      ollamaHost: this.baseUrl ?? DEFAULT_OLLAMA_HOST,
      permissions: this.permissions,
      subagentRunner: this.subagentRunner,
      codeIntel: this.codeIntel,
      todoState: this.todoState,
    })

    // keep client model tracking in sync with model-specific chat requests
    this.client.startKeepAlive(model)
  }

  // create one read-only child with borrowed integration resources
  private createReadOnlySubagent(): Agent
  {
    return new Agent(this.model, this.baseUrl, this.cwd, {
      think: this.thinkMode,
      tools: subagentTools,
      maxIterations: SUBAGENT_MAX_ITERATIONS,
      numCtx: this.numCtx,
      verifyEdits: false,
      codeIntel: this.codeIntel,
      mcp: false,
    })
  }

  // run a bounded read-only subagent and close its local scope
  private async runReadOnlySubagent(
    prompt: string,
    signal?: AbortSignal
  ): Promise<SubagentResult>
  {
    const sub = this.createReadOnlySubagent()

    let text = ''
    let error: string | undefined
    try
    {
      await sub.run(
        prompt,
        {
          onToken: (token) =>
          {
            text += token
          },
          onToolCall: () =>
          {},
          onToolResult: () =>
          {},
          // deny unexpected subagent tools instead of opening an approval prompt
          onToolApproval: async () => false,
          onDone: () =>
          {},
          onError: (err) =>
          {
            error = err.message
          },
        },
        signal
      )

      return {
        text: text.trim(),
        error,
        aborted: signal?.aborted === true,
      }
    }
    finally
    {
      await sub.dispose()
    }
  }

  // review edits with a fresh read-only subagent and return a warn-only verdict
  private async runEditVerification(
    request: string,
    diffs: string[],
    signal?: AbortSignal
  ): Promise<VerificationResult | null>
  {
    const result = await this.subagentRunner(
      buildVerifyPrompt(request, diffs),
      signal
    )

    if (result.error || result.aborted) return null
    return parseVerifyVerdict(result.text, diffs.length)
  }

  // abort active work and close Agent-local resources without evicting host models
  dispose(): Promise<void>
  {
    if (!this.disposePromise)
    {
      // abort pending bootstrap before joining cleanup
      this.lifecycleAbort.abort()
      this.contextResolutionAbort?.abort()
      this.disposePromise = this.disposeInternal()
    }
    return this.disposePromise
  }

  private async disposeInternal(): Promise<void>
  {
    await Promise.allSettled([
      ...this.activeRuns,
      ...(this.contextWindowPromise ? [this.contextWindowPromise] : []),
    ])

    try
    {
      await this.mcpScope.dispose()
    }
    finally
    {
      if (this.ownsCodeIntel) await this.codeIntel.dispose()
    }
  }

  getMcpStatus(): McpStatus
  {
    return this.mcpScope.getStatus()
  }

  private dynamicToolTokenBudget(): number
  {
    const promptLimit = requestBudgetCapacity(
      this.contextWindowSize || MIN_NUM_CTX
    ).promptLimit
    const totalToolBudget = Math.floor(promptLimit * 0.5)
    return Math.max(
      totalToolBudget - this.toolCatalog.trustedDefinitionTokens,
      0
    )
  }

  isMcpEnabled(): boolean
  {
    return this.mcpScope.isEnabled()
  }

  async setMcpEnabled(enabled: boolean, signal?: AbortSignal): Promise<void>
  {
    this.mcpScope.setEnabled(enabled, signal)
    // create a fresh manager lazily at the next run bootstrap
    if (enabled) return
    await this.mcpScope.retireCurrent(() => this.refreshTools())
  }

  // restore previous messages while keeping the system prompt at index 0
  restoreMessages(savedMessages: OllamaMessage[]): void
  {
    this.state.restoreMessages(savedMessages)
  }

  getMessages(): OllamaMessage[]
  {
    return this.state.getMessages()
  }

  getTodos(): TodoItem[]
  {
    return this.todoState.snapshot()
  }

  clearTodos(): void
  {
    this.todoState.clear()
  }

  subscribeTodos(listener: TodoListener): () => void
  {
    return this.todoState.subscribe(listener)
  }

  // restore undo records already validated by the session parser
  restoreUndoStack(
    undoStack: UndoTurn[] = [],
    redoStack: UndoTurn[] = []
  ): void
  {
    this.state.restoreUndoStack(undoStack, redoStack)
  }

  getUndoStack(): UndoTurn[]
  {
    return this.state.getUndoStack()
  }

  getRedoStack(): UndoTurn[]
  {
    return this.state.getRedoStack()
  }

  // serialize both stacks through one clone boundary
  exportUndoStateForPersistence(): { undo: UndoTurn[]; redo: UndoTurn[] }
  {
    return this.state.exportUndoState()
  }

  async undoLastTurn(signal?: AbortSignal): Promise<UndoResult>
  {
    return this.replay.undoLastTurn(signal)
  }

  async redoLastTurn(signal?: AbortSignal): Promise<UndoResult>
  {
    return this.replay.redoLastTurn(signal)
  }

  getModel(): string
  {
    return this.model
  }

  getCwd(): string
  {
    return this.cwd
  }

  hasProducedTurn(): boolean
  {
    return this.producedModels.size > 0
  }

  getReliabilityTelemetry(): Array<{
    model: string
    stats: ReliabilityStats
  }>
  {
    const byModel = new Map(this.telemetryStatsByModel)
    if (this.producedModels.has(this.model))
    {
      byModel.set(
        this.model,
        mergeReliabilityStats(byModel.get(this.model), this.reliabilityStats)
      )
    }

    return [...byModel.entries()].map(([model, stats]) => ({ model, stats }))
  }

  private foldCurrentReliability(model: string): void
  {
    if (!this.producedModels.has(model)) return
    this.telemetryStatsByModel.set(
      model,
      mergeReliabilityStats(
        this.telemetryStatsByModel.get(model),
        this.reliabilityStats
      )
    )
  }

  // switch models in place while preserving history and retiring model-local MCP state
  async switchModel(nextModel: string, signal?: AbortSignal): Promise<void>
  {
    signal?.throwIfAborted()
    this.lifecycleAbort.signal.throwIfAborted()
    this.contextResolutionAbort?.abort()
    await this.contextWindowPromise?.catch(() => undefined)
    signal?.throwIfAborted()
    this.lifecycleAbort.signal.throwIfAborted()

    // re-admit dynamic tools against the next model's context budget
    await this.mcpScope.retireCurrent(() => this.refreshTools())
    signal?.throwIfAborted()
    this.lifecycleAbort.signal.throwIfAborted()

    // stage fallible derivations before the synchronous model commit
    const systemContent = this.buildSystemContent(nextModel)
    const previousModel = this.model
    this.foldCurrentReliability(previousModel)
    this.reliabilityStats = makeReliabilityStats()

    // reset context state because a different model uses a cold runner
    this.model = nextModel
    this.contextWindowSize = 0
    this.numCtx = 0

    // rebuild the system prompt with the new model name
    this.replaceSystemPrompt(systemContent)

    // start keep-alive for the new model
    this.client.startKeepAlive(nextModel)
  }

  setCompactionConfig(config: Partial<CompactionConfig>): void
  {
    this.compactor.setConfig(config)
  }

  // reset conversation history to the system prompt and return the cleared count
  clearHistory(): number
  {
    return this.state.clearHistory()
  }

  // force compaction and return before-and-after stats
  async forceCompact(signal?: AbortSignal): Promise<CompactionResult | null>
  {
    if (this.state.getMessageCount() < 4) return null

    // resolve the exact window before direct /compact so summary requests use the real budget
    await this.fetchContextWindow(signal)
    signal?.throwIfAborted()

    return this.compactor.forceCompact(this.compactionRuntime(), signal)
  }

  getEstimatedTokens(): number
  {
    return this.compactor.estimateContextTokens(
      this.toolCatalog.definitionTokens
    )
  }

  // expose the exact last request plan without exposing mutable state
  getLastRequestBudget(): RequestBudgetBreakdown | undefined
  {
    const budget = this.lastRequestBudget
    if (!budget) return undefined
    return {
      ...budget,
      categories: { ...budget.categories },
    }
  }

  getMessageCount(): number
  {
    return Math.max(this.state.getMessageCount() - 1, 0)
  }

  // expose accumulated Ollama token usage and model time
  getTokenUsage(): {
    promptTokens: number
    completionTokens: number
    promptEvalDurationNs: number
    evalDurationNs: number
  }
  {
    return {
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
      promptEvalDurationNs: this.totalPromptEvalDurationNs,
      evalDurationNs: this.totalEvalDurationNs,
    }
  }

  // reset usage after undo or redo so /status matches live history
  resetTokenUsage(): void
  {
    this.totalPromptTokens = 0
    this.totalCompletionTokens = 0
    this.totalPromptEvalDurationNs = 0
    this.totalEvalDurationNs = 0
  }

  resetSessionMetrics(): void
  {
    this.resetTokenUsage()
    this.state.resetCompactionMetrics()
  }

  getCompactionCount(): number
  {
    return this.state.getCompactionMetrics().successfulCount
  }

  // expose the runtime post-edit self-check toggle
  getVerifyEdits(): boolean
  {
    return this.verifyEdits
  }

  setVerifyEdits(enabled: boolean): void
  {
    this.verifyEdits = enabled
  }

  getLastCompactedAt(): string | null
  {
    return this.state.getCompactionMetrics().lastCompactedAt
  }

  getReliabilityStats(): ReliabilityStats
  {
    return { ...this.reliabilityStats }
  }

  // report the byte-stable system-and-summary prefix used by compaction
  // ! Coral bookkeeping only; SWA/MLX models still re-prefill the prompt
  getFrozenPrefix(): {
    messages: number
    summaryBlocks: number
    tokens: number
    contextWindow: number
  }
  {
    const prefix = this.state.getFrozenPrefix()
    const prefixLength = this.state.getFrozenPrefixLength()
    return {
      messages: prefixLength,
      summaryBlocks: Math.max(prefixLength - 1, 0),
      tokens: prefix.reduce(
        (total, message) => total + estimateMessageTokens(message),
        0
      ),
      contextWindow: this.contextWindowSize,
    }
  }

  // resolve and pin the Ollama context window once per session
  async fetchContextWindow(signal?: AbortSignal): Promise<number>
  {
    signal?.throwIfAborted()
    this.lifecycleAbort.signal.throwIfAborted()
    if (this.contextWindowSize > 0) return this.contextWindowSize

    // share one request and clear the memo after failure so the next call retries
    if (!this.contextWindowPromise)
    {
      const controller = new AbortController()
      this.contextResolutionAbort = controller
      const resolutionSignal = AbortSignal.any([
        this.lifecycleAbort.signal,
        controller.signal,
      ])
      const pending = this.resolveContextWindow(resolutionSignal).finally(
        () =>
        {
          if (this.contextWindowPromise === pending)
          {
            this.contextWindowPromise = undefined
            this.contextResolutionAbort = undefined
          }
        }
      )
      this.contextWindowPromise = pending
    }

    const callerSignal = signal
      ? AbortSignal.any([signal, this.lifecycleAbort.signal])
      : this.lifecycleAbort.signal
    return raceAbort(this.contextWindowPromise, callerSignal)
  }

  // size the context window to memory and user limits, then pin it for the session
  private async resolveContextWindow(signal?: AbortSignal): Promise<number>
  {
    const requestedModel = this.model
    const resolved = await resolvePinnedContextWindow(
      {
        model: requestedModel,
        cwd: this.cwd,
        totalMemBytes: totalmem(),
        showModel: (model, requestSignal) =>
          this.client.showModel(model, requestSignal),
        listModels: (requestSignal) => this.client.listModels(requestSignal),
      },
      signal
    )

    if (this.model !== requestedModel) return this.contextWindowSize

    // use the request-budget fallback when model metadata is unavailable
    const contextWindow = resolved?.contextWindow ?? MIN_NUM_CTX
    this.contextWindowSize = contextWindow
    this.numCtx = contextWindow
    this.compactor.setPromptLimit(
      requestBudgetCapacity(contextWindow).promptLimit
    )
    this.replaceSystemPrompt(this.buildSystemContent(this.model))

    return this.contextWindowSize
  }

  // append through the conversation invariant owner
  private pushMessage(message: OllamaMessage): void
  {
    this.state.appendMessage(message)
  }

  private pushMessages(messages: readonly OllamaMessage[]): void
  {
    this.state.appendMessages(messages)
  }

  // snapshot mutable Agent inputs for one compaction operation
  private compactionRuntime(): CompactionRuntime
  {
    return {
      model: this.model,
      contextWindow: this.numCtx || this.contextWindowSize || MIN_NUM_CTX,
      numCtx: this.numCtx || undefined,
      toolDefinitionTokens: this.toolCatalog.definitionTokens,
    }
  }

  private createToolCatalog(dynamicTools: readonly Tool[] = []): ToolCatalog
  {
    return new ToolCatalog({
      trustedTools: this.baseTools,
      dynamicTools,
    })
  }

  // rebuild the immutable tool snapshot after dynamic changes
  private wireToolCatalog(dynamicTools: readonly Tool[] = []): void
  {
    this.toolCatalog = this.createToolCatalog(dynamicTools)
  }

  private refreshTools(): void
  {
    const catalog = this.createToolCatalog()
    const systemContent = this.buildSystemContent(
      this.model,
      projectContextBudgetForWindow(this.contextWindowSize),
      catalog
    )
    this.toolCatalog = catalog
    this.replaceSystemPrompt(systemContent)
  }

  private initializeMcp(
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void>
  {
    return this.mcpScope.bootstrap({
      maxDynamicToolTokens: this.dynamicToolTokenBudget(),
      signal,
      onLaunchApproval: events.onMcpLaunchApproval,
      admit: (tools) => this.admitMcpTools(tools),
    })
  }

  // commit one discovered tool catalog and its matching prompt atomically
  private admitMcpTools(tools: readonly Tool[]): void
  {
    const catalog = this.createToolCatalog(tools)
    let systemContent: string
    let promptLimit: number | undefined

    if (this.acceptedTurn)
    {
      const activeMessage = this.state.getMessage(this.acceptedTurn.anchor)
      if (!activeMessage)
      {
        throw new Error('Accepted turn is no longer present in Agent history')
      }
      const contextWindow = this.numCtx || this.contextWindowSize || MIN_NUM_CTX
      const plan = this.requestPlanner.fitSystemPrompt({
        contextWindow,
        activeContent: activeMessage.displayContent ?? activeMessage.content,
        tools: catalog.ollamaTools,
        desiredProjectContextBudget:
          projectContextBudgetForWindow(contextWindow),
        systemContentAt: (projectContextBudget) =>
          this.buildSystemContent(this.model, projectContextBudget, catalog),
      })
      if (!plan.budget.fits)
      {
        this.lastRequestBudget = plan.budget
        assertRequestBudget(plan.budget)
      }
      systemContent = plan.content
      promptLimit = plan.promptLimit
    }
    else
    {
      systemContent = this.buildSystemContent(
        this.model,
        projectContextBudgetForWindow(this.contextWindowSize),
        catalog
      )
    }

    this.toolCatalog = catalog
    this.replaceSystemPrompt(systemContent)
    if (promptLimit !== undefined)
    {
      this.compactor.setPromptLimit(promptLimit)
    }
  }

  // build the system prompt with the same wiring at construction and switch
  private buildSystemContent(
    model: string,
    projectContextBudget = projectContextBudgetForWindow(
      this.contextWindowSize
    ),
    catalog: ToolCatalog = this.toolCatalog
  ): string
  {
    return buildSystemPrompt({
      model,
      cwd: this.cwd,
      catalog,
      projectContextBudget,
    })
  }

  // shrink only auto-loaded project context until fixed request sources fit
  private fitSystemPromptToBudget(anchor: ConversationMessageAnchor): void
  {
    const activeMessage = this.state.getMessage(anchor)
    if (!activeMessage)
    {
      throw new Error('Accepted turn is no longer present in Agent history')
    }
    const contextWindow = this.numCtx || this.contextWindowSize || MIN_NUM_CTX
    const plan = this.requestPlanner.fitSystemPrompt({
      contextWindow,
      activeContent: activeMessage.displayContent ?? activeMessage.content,
      tools: this.toolCatalog.ollamaTools,
      desiredProjectContextBudget: projectContextBudgetForWindow(contextWindow),
      systemContentAt: (projectContextBudget) =>
        this.buildSystemContent(this.model, projectContextBudget),
    })
    this.replaceSystemPrompt(plan.content)
    if (!plan.budget.fits)
    {
      this.lastRequestBudget = plan.budget
      assertRequestBudget(plan.budget)
    }
    this.compactor.setPromptLimit(plan.promptLimit)
  }

  private replaceSystemPrompt(systemContent: string): void
  {
    this.state.replaceSystemMessage(systemContent)
  }

  // give explicit current-turn attachments half of the flexible prompt space
  private attachmentBudgetChars(
    anchor: ConversationMessageAnchor,
    cleanContent: string
  ): number
  {
    // tie this allocation to the admitted turn, never to historical attachments
    if (this.state.indexOf(anchor) < 0) return 0
    return this.requestPlanner.attachmentBudgetChars({
      contextWindow: this.numCtx || this.contextWindowSize || MIN_NUM_CTX,
      systemContent: this.state.getMessages()[0]!.content,
      cleanActiveContent: cleanContent,
      tools: this.toolCatalog.ollamaTools,
    })
  }

  // categorize one allowlisted request without double-counting sources
  private buildRequestBudget(
    messages: readonly ModelRequestMessage[],
    gitContext: OllamaMessage | null,
    anchor: ConversationMessageAnchor,
    cleanContent: string
  ): RequestBudgetBreakdown
  {
    const activeIndex = this.state.indexOf(anchor)
    if (activeIndex < 0)
    {
      throw new Error('Accepted turn is no longer present in Agent history')
    }
    return this.requestPlanner.measureRequest({
      contextWindow: this.numCtx || this.contextWindowSize || MIN_NUM_CTX,
      messages,
      activeIndex,
      cleanActiveContent: cleanContent,
      baseSystemContent: this.buildSystemContent(this.model, 0),
      tools: this.toolCatalog.ollamaTools,
      gitContext,
    })
  }

  // reserve protocol replies before executing a tool round
  private async prepareToolResultRoundAllowance(
    assistantMessage: OllamaMessage,
    minimumMessages: readonly OllamaMessage[],
    anchor: ConversationMessageAnchor,
    cleanContent: string,
    callbacks: CompactionCallbacks,
    signal?: AbortSignal
  ): Promise<ToolResultRoundAllowance>
  {
    let historyCompactionAvailable = true
    while (true)
    {
      const activeIndex = this.state.indexOf(anchor)
      if (activeIndex < 0)
      {
        throw new Error('Accepted turn is no longer present in Agent history')
      }

      const plan = this.requestPlanner.reserveToolResults({
        contextWindow: this.numCtx || this.contextWindowSize || MIN_NUM_CTX,
        storedMessages: this.state.getMessages(),
        activeIndex,
        cleanActiveContent: cleanContent,
        baseSystemContent: this.buildSystemContent(this.model, 0),
        tools: this.toolCatalog.ollamaTools,
        assistantMessage,
        minimumResultMessages: minimumMessages,
        historyCompactionAvailable,
      })

      const systemContent =
        plan.kind === 'prepared'
          ? plan.reservation.systemContent
          : plan.systemContent
      if (this.state.getMessages()[0]?.content !== systemContent)
      {
        this.replaceSystemPrompt(systemContent)
      }

      if (plan.kind === 'prepared')
      {
        return plan.reservation.allowance
      }

      if (plan.kind === 'overflow')
      {
        this.lastRequestBudget = plan.budget
        assertRequestBudget(plan.budget)
        throw new Error('Unreachable request-budget overflow')
      }

      await this.compactor.compactHistoryForHardFit({
        runtime: this.compactionRuntime(),
        anchor,
        signal,
        callbacks,
      })
      signal?.throwIfAborted()
      historyCompactionAvailable = false
    }
  }

  // signal completion on a clean run exit
  private finishRun(events: AgentEvents): void
  {
    events.onDone()
  }

  // record streamed content as a partial assistant message on abort
  private recordPartialOnAbort(
    fullContent: string,
    fullThinking: string
  ): void
  {
    if (!fullContent && !fullThinking) return
    const partial: OllamaMessage = {
      role: 'assistant',
      content: fullContent || '(interrupted)',
    }
    if (fullThinking) partial.thinking = fullThinking
    this.pushMessage(partial)
    this.producedModels.add(this.model)
  }

  // accept one semantic turn before starting cancelable enrichment
  acceptTurn(input: string | TurnInput): AcceptedTurn
  {
    this.lifecycleAbort.signal.throwIfAborted()
    if (this.acceptedTurn)
    {
      throw new Error('Agent already has an accepted turn')
    }

    const semanticInput: TurnInput =
      typeof input === 'string'
        ? { content: input }
        : {
            content: input.content,
            attachmentPaths: input.attachmentPaths
              ? Object.freeze([...input.attachmentPaths])
              : undefined,
          }
    const displayContent = semanticInput.attachmentPaths?.length
      ? semanticInput.content
      : undefined

    const handle: AcceptedTurn = Object.freeze({
      id: Symbol('accepted-turn'),
      input: Object.freeze(semanticInput),
    })
    const anchor = this.state.acceptUserMessage(
      semanticInput.content,
      displayContent
    )
    this.acceptedTurn = { handle, anchor, running: false }
    return handle
  }

  run(
    input: string | TurnInput,
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void>
  {
    if (this.lifecycleAbort.signal.aborted)
    {
      this.finishRun(events)
      return Promise.resolve()
    }

    const accepted = this.acceptTurn(input)
    return this.runAcceptedTurn(accepted, events, signal)
  }

  // join cancelable enrichment and inference to an admitted turn
  runAcceptedTurn(
    accepted: AcceptedTurn,
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void>
  {
    const active = this.acceptedTurn
    if (!active || active.handle !== accepted)
    {
      throw new Error('Accepted turn does not belong to this Agent')
    }
    if (active.running)
    {
      throw new Error('Accepted turn is already running')
    }
    active.running = true

    const runPromise = this.runInternal(active, events, signal)
    this.activeRuns.add(runPromise)
    const removeRun = () => this.activeRuns.delete(runPromise)
    void runPromise.then(removeRun, removeRun)
    return runPromise
  }

  // run a user message through the agent loop with Agent-owned cancellation
  private async runInternal(
    accepted: ActiveAcceptedTurn,
    events: AgentEvents,
    externalSignal?: AbortSignal
  ): Promise<void>
  {
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, this.lifecycleAbort.signal])
      : this.lifecycleAbort.signal
    const runAnchor = accepted.anchor
    const userMessage = accepted.handle.input.content
    // collect diffs from edit-producing tools for the self-check
    const editDiffs: string[] = []
    const fileChanges: UndoFileChange[] = []
    const todoChange: TodoChangeTracker = { before: null, after: null }
    let undoRecorded = false
    let terminalCallbackStarted = false
    const finalize = () =>
    {
      try
      {
        if (!undoRecorded)
        {
          // mark first so an undo-write failure cannot be retried into duplicate state
          undoRecorded = true
          this.state.finalizeActiveTurn(
            runAnchor,
            fileChanges,
            finalizedTodoChange(todoChange)
          )
        }
      }
      finally
      {
        if (this.acceptedTurn === accepted) this.acceptedTurn = undefined
      }
    }
    const finish = () =>
    {
      finalize()
      terminalCallbackStarted = true
      this.finishRun(events)
    }
    const fail = (error: Error) =>
    {
      finalize()
      terminalCallbackStarted = true
      events.onError(error)
    }

    try
    {
      if (signal.aborted)
      {
        finish()
        return
      }

      let capturedTurn: CapturedTurn
      let attachmentBudgetChars = 0
      // resolve context and MCP capabilities before reading attachments
      try
      {
        await this.fetchContextWindow(signal)
        signal.throwIfAborted()
        await this.initializeMcp(events, signal)
        signal.throwIfAborted()
        this.fitSystemPromptToBudget(runAnchor)
        attachmentBudgetChars = this.attachmentBudgetChars(
          runAnchor,
          userMessage
        )
        capturedTurn = await this.turnContext.capture(
          accepted.handle.input,
          signal,
          attachmentBudgetChars
        )
        signal.throwIfAborted()
      }
      catch (err)
      {
        if (signal.aborted || this.lifecycleAbort.signal.aborted)
        {
          finish()
          return
        }
        fail(toError(err))
        return
      }

      const compactionCallbacks: CompactionCallbacks = {
        onStart: events.onCompactionStart,
        onResult: events.onCompaction,
      }

      let iterations = 0
      let stallNudges = 0
      let reprompts = 0
      let verifyReprompts = 0
      const doomLoop = new DoomLoopDetector()
      let attachmentsCommitted = false
      while (true)
      {
        if (signal?.aborted)
        {
          finish()
          return
        }

        // cap tool-call rounds for subagents
        iterations++
        if (
          this.maxIterations !== undefined &&
          iterations > this.maxIterations
        )
        {
          finish()
          return
        }

        let fullContent = ''
        let fullThinking = ''
        let toolCalls: OllamaToolCall[] = []
        // retain the first doom-loop trip from this round
        let doomTrip: DoomLoopTrip | null = null

        try
        {
          let gitContext = await this.turnContext.gatherGit(signal)
          signal.throwIfAborted()
          const activeMessage = this.state.getMessage(runAnchor)
          if (!activeMessage)
          {
            throw new Error(
              'Accepted turn is no longer present in Agent history'
            )
          }

          // account for the complete attachment block during compaction without storing it early
          const pendingMaterialization = attachmentsCommitted
            ? null
            : this.turnContext.materialize(capturedTurn, attachmentBudgetChars)
          const pendingContent = pendingMaterialization
            ? appendAttachmentContext(
                userMessage,
                pendingMaterialization.context
              )
            : activeMessage.content
          const pendingAttachmentTokens = attachmentsCommitted
            ? 0
            : estimateModelRequestMessageDeltaTokens(activeMessage, {
                ...activeMessage,
                content: pendingContent,
              })
          const volatileTokens =
            (gitContext ? estimateMessageTokens(gitContext) : 0) +
            pendingAttachmentTokens

          await this.compactor.compactIfNeeded({
            runtime: this.compactionRuntime(),
            volatileTokens,
            signal,
            callbacks: compactionCallbacks,
          })
          signal.throwIfAborted()

          // preserve the active turn when the hard message-count guard fires
          if (this.state.getMessageCount() > DEFAULT_MAX_HISTORY)
          {
            this.state.trimToMax(DEFAULT_MAX_HISTORY)
          }

          let preparedRequest: PreparedModelRequest | null = null
          let historyCompactionAvailable = true
          while (!preparedRequest)
          {
            const activeIndex = this.state.indexOf(runAnchor)
            if (activeIndex < 0)
            {
              throw new Error(
                'Accepted turn is no longer present in Agent history'
              )
            }

            const plan = this.requestPlanner.planModelRequest({
              contextWindow:
                this.numCtx || this.contextWindowSize || MIN_NUM_CTX,
              storedMessages: this.state.getMessages(),
              activeIndex,
              cleanActiveContent: userMessage,
              baseSystemContent: this.buildSystemContent(this.model, 0),
              tools: this.toolCatalog.ollamaTools,
              gitContext,
              ...(attachmentsCommitted
                ? {}
                : {
                    pendingAttachments: {
                      capture: capturedTurn.attachments,
                      maxChars: attachmentBudgetChars,
                    },
                  }),
              historyCompactionAvailable,
            })

            if (plan.kind === 'prepared')
            {
              preparedRequest = plan.request
              break
            }

            if (this.state.getMessages()[0]?.content !== plan.systemContent)
            {
              this.replaceSystemPrompt(plan.systemContent)
            }
            gitContext = plan.gitContext
            await this.compactor.compactHistoryForHardFit({
              runtime: this.compactionRuntime(),
              anchor: runAnchor,
              signal,
              callbacks: compactionCallbacks,
            })
            signal.throwIfAborted()
            historyCompactionAvailable = false
          }

          if (
            this.state.getMessages()[0]?.content !==
            preparedRequest.systemContent
          )
          {
            this.replaceSystemPrompt(preparedRequest.systemContent)
          }

          const requestMessages = preparedRequest.messages
          const requestBudget = preparedRequest.budget
          this.lastRequestBudget = requestBudget
          assertRequestBudget(requestBudget)
          signal.throwIfAborted()

          if (!attachmentsCommitted)
          {
            const attachmentCommit = preparedRequest.attachmentCommit
            if (!attachmentCommit)
            {
              throw new Error('Pending attachment request was not prepared')
            }
            const attachmentMaterialization =
              (accepted.handle.input.attachmentPaths?.length ?? 0) > 0
                ? attachmentCommit.materialization
                : undefined
            const committed = this.state.commitActiveUserMessage(
              runAnchor,
              attachmentCommit.content,
              attachmentMaterialization
                ? attachmentReportFromMaterialization(attachmentMaterialization)
                : undefined
            )
            if (!committed)
            {
              throw new Error(
                'Accepted turn is no longer present in Agent history'
              )
            }
            attachmentsCommitted = true
            if (attachmentMaterialization)
            {
              events.onAttachments?.(attachmentMaterialization)
            }
          }

          for await (const chunk of this.client.chatStream(
            {
              model: this.model,
              messages: requestMessages,
              tools: [...this.toolCatalog.ollamaTools],
              think: this.thinkMode,
              num_ctx: this.numCtx || undefined,
              num_predict: requestBudget.responseReserve,
            },
            signal
          ))
          {
            if (signal?.aborted) break

            if (chunk.message.thinking)
            {
              fullThinking += chunk.message.thinking
              events.onThinking?.(chunk.message.thinking)
            }
            if (chunk.message.content)
            {
              fullContent += chunk.message.content
              events.onToken(chunk.message.content)
            }
            if (chunk.message.tool_calls?.length)
            {
              toolCalls = mergeToolCalls(toolCalls, chunk.message.tool_calls)
            }
            // capture token usage and model time from the final chunk
            if (chunk.done)
            {
              const promptTokens = chunk.prompt_eval_count ?? 0
              const completionTokens = chunk.eval_count ?? 0
              const promptEvalDurationNs = chunk.prompt_eval_duration
              const evalDurationNs = chunk.eval_duration
              this.totalPromptTokens += promptTokens
              this.totalCompletionTokens += completionTokens
              if (promptEvalDurationNs && promptEvalDurationNs > 0)
              {
                this.totalPromptEvalDurationNs += promptEvalDurationNs
              }
              if (evalDurationNs && evalDurationNs > 0)
              {
                this.totalEvalDurationNs += evalDurationNs
              }
              events.onUsage?.({
                promptTokens,
                completionTokens,
                totalPromptTokens: this.totalPromptTokens,
                totalCompletionTokens: this.totalCompletionTokens,
                contextTokens: requestBudget.promptTokens,
                promptEvalDurationNs,
                evalDurationNs,
                totalPromptEvalDurationNs: this.totalPromptEvalDurationNs,
                totalEvalDurationNs: this.totalEvalDurationNs,
              })
            }
          }
        }
        catch (err)
        {
          // treat fetch abort as clean cancellation
          if (signal?.aborted)
          {
            // preserve streamed content as a partial message
            this.recordPartialOnAbort(fullContent, fullThinking)
            finish()
            return
          }

          // record undo for prior mutations without signaling clean completion
          fail(toError(err))
          return
        }

        // save partial content and stop after a mid-stream abort
        if (signal?.aborted)
        {
          this.recordPartialOnAbort(fullContent, fullThinking)
          finish()
          return
        }

        // recover tool calls emitted as text content
        if (toolCalls.length === 0 && fullContent.trim())
        {
          const repaired = parseToolCallsFromContent(
            fullContent,
            this.toolCatalog.names
          )

          if (repaired)
          {
            toolCalls = repaired
            this.reliabilityStats.repairedToolCalls += repaired.length
          }
        }

        const preparedToolRound =
          toolCalls.length > 0
            ? this.toolRounds.prepare(toolCalls, this.toolCatalog)
            : undefined
        if (preparedToolRound)
        {
          this.reliabilityStats.nameRepairs += preparedToolRound.nameRepairs
        }

        // record the repaired assistant message so history carries tool calls
        const assistantMessage: OllamaMessage = {
          role: 'assistant',
          content: fullContent,
        }
        if (fullThinking)
        {
          assistantMessage.thinking = fullThinking
        }
        if (preparedToolRound)
        {
          assistantMessage.tool_calls = [...preparedToolRound.storedCalls]
        }

        let toolResultAllowance: ToolResultRoundAllowance | undefined
        if (preparedToolRound)
        {
          try
          {
            toolResultAllowance = await this.prepareToolResultRoundAllowance(
              assistantMessage,
              preparedToolRound.minimumResultMessages,
              runAnchor,
              userMessage,
              compactionCallbacks,
              signal
            )
          }
          catch (err)
          {
            if (signal?.aborted)
            {
              finish()
              return
            }
            fail(toError(err))
            return
          }
        }
        this.producedModels.add(this.model)

        if (toolCalls.length === 0)
        {
          this.pushMessage(assistantMessage)
          // nudge a fully empty turn because it is a dead end, not an answer
          if (
            !fullContent.trim() &&
            !fullThinking.trim() &&
            stallNudges < MAX_STALL_NUDGES
          )
          {
            stallNudges++
            this.reliabilityStats.stallNudges++
            this.pushMessage({ role: 'user', content: STALL_NUDGE_MESSAGE })
            continue
          }

          // reprompt a botched call that repair could not recover
          if (
            reprompts < MAX_REPROMPTS &&
            fullContent.trim() &&
            looksLikeAttemptedToolCall(fullContent, this.toolCatalog.names)
          )
          {
            reprompts++
            this.reliabilityStats.reprompts++
            this.pushMessage({ role: 'user', content: REPROMPT_MESSAGE })
            continue
          }

          // optionally self-check edits before clean completion
          if (this.verifyEdits && editDiffs.length > 0 && !signal?.aborted)
          {
            const verdict = await this.runEditVerification(
              userMessage,
              editDiffs,
              signal
            )
            if (verdict)
            {
              if (verdict.status !== 'pass') this.reliabilityStats.verifyFlags++

              // feed a failed verdict back to the model within the retry cap
              const willRetry =
                verdict.status === 'fail' &&
                verifyReprompts < MAX_VERIFY_REPROMPTS &&
                !signal?.aborted
              verdict.retrying = willRetry
              events.onVerification?.(verdict)

              if (willRetry)
              {
                verifyReprompts++
                this.reliabilityStats.verifyReprompts++
                this.pushMessage({
                  role: 'user',
                  content: buildVerifyReprompt(verdict.reason),
                })
                continue
              }
            }
          }

          finish()
          return
        }

        if (!preparedToolRound || !toolResultAllowance)
        {
          fail(new Error('Prepared tool round lost its reservation'))
          return
        }

        const toolExecution = await this.toolRounds.execute({
          round: preparedToolRound,
          allowance: toolResultAllowance,
          events,
          doomLoop,
          signal,
        })
        const { outcome } = toolExecution

        // fold all completed mutations before honoring an executor failure
        editDiffs.push(...outcome.effects.editDiffs)
        fileChanges.push(
          ...outcome.effects.fileChanges.map((change) => ({ ...change }))
        )
        if (outcome.effects.todoChange)
        {
          todoChange.before ??= cloneTodoItems(
            outcome.effects.todoChange.before
          )
          todoChange.after = cloneTodoItems(outcome.effects.todoChange.after)
        }
        this.reliabilityStats.validationFailures +=
          outcome.reliability.validationFailures
        this.reliabilityStats.editRepairs += outcome.reliability.editRepairs
        if (outcome.doomTrip && !doomTrip) doomTrip = outcome.doomTrip

        if (toolExecution.status === 'failed')
        {
          if (signal.aborted || this.lifecycleAbort.signal.aborted)
          {
            finish()
            return
          }
          fail(toolExecution.error)
          return
        }

        const toolResults = [...outcome.toolResults]
        // stage the assistant call and results as one protected round before history commit
        const projectedRound = this.buildRequestBudget(
          [...this.state.getMessages(), assistantMessage, ...toolResults].map(
            toModelRequestMessage
          ),
          null,
          runAnchor,
          userMessage
        )
        if (!projectedRound.fits)
        {
          this.lastRequestBudget = projectedRound
          try
          {
            assertRequestBudget(projectedRound)
          }
          catch (err)
          {
            fail(toError(err))
          }
          return
        }
        this.pushMessages([assistantMessage, ...toolResults])

        if (outcome.aborted)
        {
          finish()
          return
        }
        // pause for user confirmation when the interactive loop shows a stuck pattern
        if (doomTrip && events.onDoomLoop)
        {
          this.reliabilityStats.doomLoopTrips++
          let proceed: boolean
          try
          {
            proceed = await raceAbort(
              events.onDoomLoop(describeDoomLoop(doomTrip)),
              signal
            )
          }
          catch
          {
            finish()
            return
          }

          if (!proceed)
          {
            finish()
            return
          }
          // fresh streak required before tripping again
          doomLoop.reset()
        }
      }
    }
    catch (err)
    {
      // route host callback failures through the normal failure channel after releasing ownership
      if (terminalCallbackStarted) throw err
      if (signal.aborted || this.lifecycleAbort.signal.aborted)
      {
        finish()
        return
      }
      fail(toError(err))
    }
    finally
    {
      // release the accepted turn after all callback and internal failure paths
      finalize()
    }
  }
}
