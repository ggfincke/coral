// src/agent/loop/request-planner.ts
// deterministic model-request planning and fallback policy

import type {
  ModelRequestMessage,
  OllamaMessage,
  OllamaTool,
} from '../../types/inference.js'
import { CHARS_PER_TOKEN } from '../../utils/limits.js'
import {
  appendAttachmentContext,
  materializeAttachments,
  materializeAttachmentsToFit,
  type AttachmentCapture,
  type AttachmentMaterialization,
} from '../request/attachments.js'
import {
  attachmentAllowanceForFixedCost,
  createRequestBudgetBreakdown,
  requestBudgetCapacity,
  type RequestBudgetBreakdown,
} from '../request/budget.js'
import {
  estimateModelRequestMessageDeltaTokens,
  estimateModelRequestMessageTokens,
  estimateModelRequestMessagesTokens,
  estimateModelRequestToolTokens,
  estimateRequestFramingTokens,
  toModelRequestMessage,
} from '../request/projection.js'

export interface RequestPlanningSnapshot
{
  contextWindow: number
  storedMessages: readonly OllamaMessage[]
  activeIndex: number
  cleanActiveContent: string
  baseSystemContent: string
  tools: readonly OllamaTool[]
}

export interface PendingAttachmentPlan
{
  capture: AttachmentCapture
  maxChars: number
}

export interface ModelRequestPlanInput extends RequestPlanningSnapshot
{
  gitContext: OllamaMessage | null
  pendingAttachments?: PendingAttachmentPlan
  historyCompactionAvailable: boolean
}

export interface AttachmentCommit
{
  content: string
  materialization: AttachmentMaterialization
}

export interface PreparedModelRequest
{
  messages: ModelRequestMessage[]
  budget: RequestBudgetBreakdown
  systemContent: string
  attachmentCommit?: AttachmentCommit
}

export type ModelRequestPlan =
  | {
      kind: 'prepared'
      request: PreparedModelRequest
    }
  | {
      kind: 'needs_history_compaction'
      budget: RequestBudgetBreakdown
      systemContent: string
      gitContext: OllamaMessage | null
    }

export interface RequestMeasurementInput
{
  contextWindow: number
  messages: readonly ModelRequestMessage[]
  activeIndex: number
  cleanActiveContent: string
  baseSystemContent: string
  tools: readonly OllamaTool[]
  gitContext: OllamaMessage | null
}

export interface SystemPromptFitInput
{
  contextWindow: number
  activeContent: string
  tools: readonly OllamaTool[]
  desiredProjectContextBudget: number
  systemContentAt: (projectContextBudget: number) => string
}

export interface SystemPromptPlan
{
  content: string
  promptLimit: number
  budget: RequestBudgetBreakdown
}

export interface AttachmentBudgetInput
{
  contextWindow: number
  systemContent: string
  cleanActiveContent: string
  tools: readonly OllamaTool[]
}

export interface ToolResultReservationInput extends RequestPlanningSnapshot
{
  assistantMessage: OllamaMessage
  minimumResultMessages: readonly OllamaMessage[]
  historyCompactionAvailable: boolean
}

export interface ToolResultAllowanceSeed
{
  minimumTokens: readonly number[]
  remainingTokens: number
}

export interface PreparedToolResultReservation
{
  budget: RequestBudgetBreakdown
  systemContent: string
  allowance: ToolResultAllowanceSeed
}

export type ToolResultReservationPlan =
  | {
      kind: 'prepared'
      reservation: PreparedToolResultReservation
    }
  | {
      kind: 'needs_history_compaction'
      budget: RequestBudgetBreakdown
      systemContent: string
    }
  | {
      kind: 'overflow'
      budget: RequestBudgetBreakdown
      systemContent: string
    }

interface RequestCandidate
{
  messages: ModelRequestMessage[]
  budget: RequestBudgetBreakdown
}

// plan exact model requests without owning conversation state or compaction
export class RequestPlanner
{
  fitSystemPrompt(input: SystemPromptFitInput): SystemPromptPlan
  {
    const capacity = requestBudgetCapacity(input.contextWindow)
    const baseContent = input.systemContentAt(0)
    const baseMessage: ModelRequestMessage = {
      role: 'system',
      content: baseContent,
    }
    const activeBase: ModelRequestMessage = {
      role: 'user',
      content: input.activeContent,
    }
    const fixedCategories = {
      systemBase: estimateModelRequestMessageTokens(baseMessage),
      activeTurnBase: estimateModelRequestMessageTokens(activeBase),
      toolDefinitions: estimateModelRequestToolTokens(input.tools),
      framing: estimateRequestFramingTokens(2),
    }
    const baseBudget = createRequestBudgetBreakdown(
      input.contextWindow,
      fixedCategories
    )
    if (!baseBudget.fits)
    {
      return {
        content: baseContent,
        promptLimit: capacity.promptLimit,
        budget: baseBudget,
      }
    }

    const desiredContent = input.systemContentAt(
      input.desiredProjectContextBudget
    )
    const desiredBudget = this.systemPromptBudget(
      input.contextWindow,
      fixedCategories,
      baseMessage,
      desiredContent
    )
    if (desiredBudget.fits)
    {
      return {
        content: desiredContent,
        promptLimit: capacity.promptLimit,
        budget: desiredBudget,
      }
    }

    let low = 0
    let high = Math.max(input.desiredProjectContextBudget - 1, 0)
    let bestContent = baseContent
    let bestBudget = baseBudget

    while (low <= high)
    {
      const projectContextBudget = Math.floor((low + high) / 2)
      const content = input.systemContentAt(projectContextBudget)
      const candidate = this.systemPromptBudget(
        input.contextWindow,
        fixedCategories,
        baseMessage,
        content
      )

      if (candidate.fits)
      {
        bestContent = content
        bestBudget = candidate
        low = projectContextBudget + 1
      }
      else
      {
        high = projectContextBudget - 1
      }
    }

    return {
      content: bestContent,
      promptLimit: capacity.promptLimit,
      budget: bestBudget,
    }
  }

  attachmentBudgetChars(input: AttachmentBudgetInput): number
  {
    const fixedPromptTokens =
      estimateModelRequestMessageTokens({
        role: 'system',
        content: input.systemContent,
      }) +
      estimateModelRequestMessageTokens({
        role: 'user',
        content: input.cleanActiveContent,
      }) +
      estimateModelRequestToolTokens(input.tools) +
      estimateRequestFramingTokens(2)
    const capacity = requestBudgetCapacity(input.contextWindow)
    return (
      attachmentAllowanceForFixedCost(capacity.promptLimit, fixedPromptTokens) *
      CHARS_PER_TOKEN
    )
  }

  planModelRequest(input: ModelRequestPlanInput): ModelRequestPlan
  {
    const currentSystem = input.storedMessages[0]
    if (!currentSystem || currentSystem.role !== 'system')
    {
      throw new Error('Request planning requires a system message')
    }
    this.activeMessage(input)

    const fullMaterialization = input.pendingAttachments
      ? materializeAttachments(
          input.pendingAttachments.capture,
          input.pendingAttachments.maxChars
        )
      : undefined
    let systemContent = currentSystem.content
    let gitContext = input.gitContext
    let candidate = this.requestCandidate(
      input,
      systemContent,
      gitContext,
      input.pendingAttachments ? fullMaterialization!.context : undefined
    )

    // degrade volatile repository detail before durable context
    if (!candidate.budget.fits && gitContext)
    {
      gitContext = this.compactGitContext(gitContext)
      candidate = this.requestCandidate(
        input,
        systemContent,
        gitContext,
        input.pendingAttachments ? fullMaterialization!.context : undefined
      )
    }
    if (!candidate.budget.fits && gitContext)
    {
      gitContext = null
      candidate = this.requestCandidate(
        input,
        systemContent,
        gitContext,
        input.pendingAttachments ? fullMaterialization!.context : undefined
      )
    }

    // remove optional project text before protected history or turn bytes
    if (!candidate.budget.fits && systemContent !== input.baseSystemContent)
    {
      systemContent = input.baseSystemContent
      candidate = this.requestCandidate(
        input,
        systemContent,
        gitContext,
        input.pendingAttachments ? fullMaterialization!.context : undefined
      )
    }

    if (!candidate.budget.fits && input.historyCompactionAvailable)
    {
      return {
        kind: 'needs_history_compaction',
        budget: candidate.budget,
        systemContent,
        gitContext,
      }
    }

    let finalMaterialization = fullMaterialization
    if (input.pendingAttachments)
    {
      finalMaterialization = materializeAttachmentsToFit(
        input.pendingAttachments.capture,
        input.pendingAttachments.maxChars,
        (context) =>
          this.requestCandidate(input, systemContent, gitContext, context)
            .budget.fits
      )
      candidate = this.requestCandidate(
        input,
        systemContent,
        gitContext,
        finalMaterialization.context
      )
    }

    const attachmentCommit = finalMaterialization
      ? {
          content: appendAttachmentContext(
            input.cleanActiveContent,
            finalMaterialization.context
          ),
          materialization: finalMaterialization,
        }
      : undefined

    return {
      kind: 'prepared',
      request: {
        messages: candidate.messages,
        budget: candidate.budget,
        systemContent,
        ...(attachmentCommit ? { attachmentCommit } : {}),
      },
    }
  }

  reserveToolResults(
    input: ToolResultReservationInput
  ): ToolResultReservationPlan
  {
    const currentSystem = input.storedMessages[0]
    if (!currentSystem || currentSystem.role !== 'system')
    {
      throw new Error('Tool-result reservation requires a system message')
    }
    this.activeMessage(input)

    let systemContent = currentSystem.content
    let projectedMessages = this.toolResultMessages(input, systemContent, true)
    let budget = this.measureRequest({
      contextWindow: input.contextWindow,
      messages: projectedMessages,
      activeIndex: input.activeIndex,
      cleanActiveContent: input.cleanActiveContent,
      baseSystemContent: input.baseSystemContent,
      tools: input.tools,
      gitContext: null,
    })

    if (!budget.fits && systemContent !== input.baseSystemContent)
    {
      systemContent = input.baseSystemContent
      projectedMessages = this.toolResultMessages(input, systemContent, true)
      budget = this.measureRequest({
        contextWindow: input.contextWindow,
        messages: projectedMessages,
        activeIndex: input.activeIndex,
        cleanActiveContent: input.cleanActiveContent,
        baseSystemContent: input.baseSystemContent,
        tools: input.tools,
        gitContext: null,
      })
    }

    if (!budget.fits)
    {
      return input.historyCompactionAvailable
        ? {
            kind: 'needs_history_compaction',
            budget,
            systemContent,
          }
        : {
            kind: 'overflow',
            budget,
            systemContent,
          }
    }

    const baseMessages = this.toolResultMessages(input, systemContent, false)
    const capacity = requestBudgetCapacity(input.contextWindow)
    const basePromptTokens =
      estimateModelRequestMessagesTokens(baseMessages) +
      estimateModelRequestToolTokens(input.tools) +
      estimateRequestFramingTokens(
        baseMessages.length + input.minimumResultMessages.length
      )
    const minimumTokens = input.minimumResultMessages.map(
      estimateModelRequestMessageTokens
    )
    const remainingMinimumTokens = minimumTokens.reduce(
      (total, tokens) => total + tokens,
      0
    )
    const remainingTokens = capacity.promptLimit - basePromptTokens
    if (remainingTokens < remainingMinimumTokens)
    {
      throw new Error(
        'Tool-result round reservation drifted from request budget'
      )
    }

    return {
      kind: 'prepared',
      reservation: {
        budget,
        systemContent,
        allowance: Object.freeze({
          minimumTokens: Object.freeze(minimumTokens),
          remainingTokens,
        }),
      },
    }
  }

  measureRequest(input: RequestMeasurementInput): RequestBudgetBreakdown
  {
    const system = input.messages[0]
    const active = input.messages[input.activeIndex]
    if (!system || system.role !== 'system')
    {
      throw new Error('Request measurement requires a system message')
    }
    if (!active)
    {
      throw new Error('Request measurement requires an active message')
    }

    const baseSystem: ModelRequestMessage = {
      role: 'system',
      content: input.baseSystemContent,
    }
    const baseActive: ModelRequestMessage = {
      role: 'user',
      content: input.cleanActiveContent,
    }
    const gitContextTokens = input.gitContext
      ? estimateModelRequestMessageTokens(input.messages.at(-1)!)
      : 0
    const messageTokens = estimateModelRequestMessagesTokens(input.messages)
    const storedHistory = Math.max(
      messageTokens -
        estimateModelRequestMessageTokens(system) -
        estimateModelRequestMessageTokens(active) -
        gitContextTokens,
      0
    )

    return createRequestBudgetBreakdown(input.contextWindow, {
      systemBase: estimateModelRequestMessageTokens(baseSystem),
      projectContext: estimateModelRequestMessageDeltaTokens(
        baseSystem,
        system
      ),
      storedHistory,
      activeTurnBase: estimateModelRequestMessageTokens(baseActive),
      activeAttachments: estimateModelRequestMessageDeltaTokens(
        baseActive,
        active
      ),
      toolDefinitions: estimateModelRequestToolTokens(input.tools),
      gitContext: gitContextTokens,
      framing: estimateRequestFramingTokens(input.messages.length),
    })
  }

  private systemPromptBudget(
    contextWindow: number,
    fixedCategories: {
      systemBase: number
      activeTurnBase: number
      toolDefinitions: number
      framing: number
    },
    baseMessage: ModelRequestMessage,
    content: string
  ): RequestBudgetBreakdown
  {
    return createRequestBudgetBreakdown(contextWindow, {
      ...fixedCategories,
      projectContext: estimateModelRequestMessageDeltaTokens(baseMessage, {
        role: 'system',
        content,
      }),
    })
  }

  private activeMessage(input: RequestPlanningSnapshot): OllamaMessage
  {
    const active = input.storedMessages[input.activeIndex]
    if (!active)
    {
      throw new Error('Request planning requires an active message')
    }
    return active
  }

  private requestCandidate(
    input: RequestPlanningSnapshot,
    systemContent: string,
    gitContext: OllamaMessage | null,
    attachmentContext?: string | null
  ): RequestCandidate
  {
    const messages = input.storedMessages.map(toModelRequestMessage)
    messages[0] = { role: 'system', content: systemContent }
    if (attachmentContext !== undefined)
    {
      messages[input.activeIndex] = {
        ...messages[input.activeIndex]!,
        content: appendAttachmentContext(
          input.cleanActiveContent,
          attachmentContext
        ),
      }
    }
    if (gitContext) messages.push(toModelRequestMessage(gitContext))

    return {
      messages,
      budget: this.measureRequest({
        contextWindow: input.contextWindow,
        messages,
        activeIndex: input.activeIndex,
        cleanActiveContent: input.cleanActiveContent,
        baseSystemContent: input.baseSystemContent,
        tools: input.tools,
        gitContext,
      }),
    }
  }

  private toolResultMessages(
    input: ToolResultReservationInput,
    systemContent: string,
    includeMinimumResults: boolean
  ): ModelRequestMessage[]
  {
    const messages = input.storedMessages.map(toModelRequestMessage)
    messages[0] = { role: 'system', content: systemContent }
    messages.push(toModelRequestMessage(input.assistantMessage))
    if (includeMinimumResults)
    {
      messages.push(...input.minimumResultMessages.map(toModelRequestMessage))
    }
    return messages
  }

  private compactGitContext(gitContext: OllamaMessage): OllamaMessage | null
  {
    const keep = /^(## Git Context|- (root|cwd|branch|operation|status):)/
    const lines = gitContext.content
      .split('\n')
      .filter((line) => keep.test(line))
    if (lines.length <= 1) return null
    return {
      role: 'system',
      content: `${lines.join('\n')}\n- detail: omitted to fit request budget`,
    }
  }
}
