// src/agent/contracts.ts
// public Agent values and callback contracts

import type { ToolPermissions } from '../config/permissions.js'
import type { McpConfigResolution } from '../config/mcp.js'
import type { CodeIntelService } from '../lsp/contracts.js'
import type {
  ActiveMcpMode,
  McpLaunchApprovalRequest,
  McpMode,
  McpStatus,
} from '../mcp/types.js'
import type { SubagentRunner } from '../tools/subagent.js'
import type { Tool, ToolCallPresentation } from '../tools/tool.js'
import type { TodoState } from '../types/todo.js'
import type { AttachmentMaterialization } from './request/attachments.js'
import type { CompactionResult } from './state/compaction.js'
import type { AgentInferenceClient } from './inference-client.js'
import type {
  TurnContextDependencies,
  TurnInput,
} from './request/turn-context.js'
import type { VerificationResult } from './loop/edit-verification.js'

// token usage reported by Ollama; durations use nanoseconds
export interface TokenUsage
{
  promptTokens: number
  completionTokens: number
  totalPromptTokens: number
  totalCompletionTokens: number
  // current context occupancy used by compaction
  contextTokens: number
  // current-turn durations when the server reports them
  promptEvalDurationNs?: number
  evalDurationNs?: number
  totalPromptEvalDurationNs: number
  totalEvalDurationNs: number
}

// callbacks for streaming tokens, tool calls, and completion
export interface AgentEvents
{
  onToken: (token: string) => void
  onThinking?: (thinking: string) => void
  // correlate each result when parallel calls are announced before resolution
  onToolCall: (
    name: string,
    args: Record<string, unknown>,
    callId: number,
    presentation?: ToolCallPresentation
  ) => void
  onToolResult: (
    name: string,
    result: string,
    error: string | undefined,
    callId: number,
    diff?: string
  ) => void
  // approve or reject a require_approval invocation
  onToolApproval: (
    name: string,
    args: Record<string, unknown>,
    presentation?: ToolCallPresentation
  ) => Promise<boolean>
  // launch trust is separate from per-tool approval and is never automatic
  onMcpLaunchApproval?: (request: McpLaunchApprovalRequest) => Promise<boolean>
  // continue or stop after a stuck loop is detected
  onDoomLoop?: (message: string) => Promise<boolean>
  // report the warn-only post-edit self-check result
  onVerification?: (result: VerificationResult) => void
  onUsage?: (usage: TokenUsage) => void
  // report one atomic attachment materialization for transcript notices
  onAttachments?: (result: AttachmentMaterialization) => void
  // report before a summarization model call starts
  onCompactionStart?: () => void
  // report after pruning or summarization completes
  onCompaction?: (result: CompactionResult) => void
  onDone: () => void
  onError: (error: Error) => void
}

export interface AgentMcpManager
{
  initialize(options: {
    signal?: AbortSignal
    onLaunchApproval?: (request: McpLaunchApprovalRequest) => Promise<boolean>
  }): Promise<Tool[]>
  getStatus(): McpStatus
  dispose(): Promise<void>
}

export type AgentMcpManagerFactory = (
  mode: ActiveMcpMode
) => Promise<AgentMcpManager>

export interface AgentOptions
{
  think?: boolean | 'low' | 'medium' | 'high'
  // restrict the tool set for read-only subagents
  tools?: readonly Tool[]
  // cap tool-call rounds; undefined means unlimited
  maxIterations?: number
  // inherit the parent's num_ctx so subagents preserve the Ollama KV cache
  numCtx?: number
  // run a read-only self-check after edit-producing turns
  verifyEdits?: boolean
  // override local and user tool policy for deterministic callers
  permissions?: ToolPermissions
  // share the interactive Agent's lazy LSP client with read-only subagents
  codeIntel?: CodeIntelService
  // select user-configured MCP capability policy for this Agent
  mcpMode?: McpMode
  // reuse one MCP config snapshot across primary Agent replacements and mode changes
  mcpConfig?: McpConfigResolution
  // inject restored session state before the Agent becomes observable
  todoState?: TodoState
  // deterministic context I/O seam for the turn assembler
  turnContext?: TurnContextDependencies
  // narrow transport seam; production uses the Ollama client by default
  inferenceClient?: AgentInferenceClient
  // share one runner between the task tool and post-edit verification
  readOnlySubagentRunner?: SubagentRunner
  // preserve lazy MCP SDK loading while allowing manager test doubles
  mcpManagerFactory?: AgentMcpManagerFactory
}

// opaque receipt that joins an admitted turn to its run
export interface AcceptedTurn
{
  readonly id: symbol
  readonly input: TurnInput
}
