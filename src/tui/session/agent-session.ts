// src/tui/session/agent-session.ts
// construct primary Agents, bridge persisted sessions, & generate titles

import { existsSync } from 'node:fs'
import { Agent } from '../../agent/agent.js'
import type { AgentInferenceClient } from '../../agent/inference-client.js'
import { AgentTodoState } from '../../agent/state/todos.js'
import type { McpConfigResolution } from '../../config/mcp.js'
import type { McpMode } from '../../mcp/types.js'
import {
  createSession,
  derivedSessionTitle,
  loadSession,
  saveSession,
} from '../../session/store.js'
import {
  isValidSessionId,
  type SessionData,
  type SessionMeta,
} from '../../session/types.js'
import type { OllamaMessage } from '../../types/inference.js'
import { findUserTurnStarts, type UndoTurn } from '../../types/undo.js'
import { ellipsize } from '../../utils/ellipsize.js'

export interface StartupSession
{
  session: SessionData | null
}

export interface PrimaryAgentOptions
{
  model: string
  host: string
  cwd?: string
  think: boolean
  mcpMode: McpMode
  mcpConfig: McpConfigResolution
  restored?: SessionData | null
  // composition-root transport injection; one shared client per session hook
  inferenceClient?: AgentInferenceClient
}

export function resolveStartupSession(
  resumeSessionId?: string
): StartupSession
{
  if (!resumeSessionId || !isValidSessionId(resumeSessionId))
  {
    return { session: null }
  }

  const session = loadSession(resumeSessionId)
  if (!session || !existsSync(session.meta.cwd)) return { session: null }
  return { session }
}

export function buildPrimaryAgent(options: PrimaryAgentOptions): Agent
{
  const agent = new Agent(options.model, options.host, options.cwd, {
    think: options.think,
    mcpMode: options.mcpMode,
    mcpConfig: options.mcpConfig,
    todoState: new AgentTodoState(options.restored?.todos),
    inferenceClient: options.inferenceClient,
  })
  if (options.restored)
  {
    agent.restoreMessages(options.restored.messages)
    agent.restoreUndoStack(options.restored.undo, options.restored.redo)
  }
  return agent
}

export function persistAgentSession(
  agent: Agent,
  target: SessionMeta | null
): SessionMeta | null
{
  try
  {
    const messages = agent.getMessages()
    const model = agent.getModel()
    const cwd = agent.getCwd()
    const todos = agent.getTodos()
    const { undo, redo } = agent.exportUndoStateForPersistence()
    const metaHint = {
      compactionCount: agent.getCompactionCount(),
      lastCompactedAt: agent.getLastCompactedAt() ?? undefined,
      ...(target
        ? {
            createdAt: target.createdAt,
            title: target.title,
          }
        : {}),
    }

    return target
      ? saveSession(
          target.id,
          model,
          cwd,
          messages,
          metaHint,
          todos,
          undo,
          redo
        )
      : createSession(model, cwd, messages, todos, undo, redo)
  }
  catch
  {
    // session save failure is non-fatal
    return null
  }
}

// --- background session-title generation ---

// prompt payload bounds; stored titles get their own tighter cap
const TITLE_PROMPT_USER_CHARS = 500
const TITLE_PROMPT_REPLY_CHARS = 300
const TITLE_MAX_CHARS = 60

const TITLE_SYSTEM_PROMPT =
  'Write a 3-6 word title for this coding session based on the exchange. Reply with ONLY the title.'

// strip control chars/newlines, collapse whitespace, and cap; null skips apply
export function sanitizeSessionTitle(raw: string): string | null
{
  let cleaned = ''
  for (const char of raw)
  {
    const code = char.codePointAt(0)!
    // controls (incl newlines) become separators so multi-line replies flatten
    cleaned += code <= 0x1f || code === 0x7f ? ' ' : char
  }
  const collapsed = cleaned.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  return ellipsize(collapsed, TITLE_MAX_CHARS)
}

// first exchange reduced to bounded plain text; tool traffic in between is
// skipped so the prompt carries only what the user asked and the final reply
export function extractFirstExchange(
  messages: readonly OllamaMessage[],
  undo: readonly UndoTurn[] = []
): { user: string; assistant: string } | null
{
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
  const [userIndex, nextUserIndex = messages.length] = findUserTurnStarts(
    messages,
    undo
  )
  if (userIndex === undefined) return null

  const userMessage = messages[userIndex]!
  const reply = messages.findLast(
    (message, index) =>
      index > userIndex &&
      index < nextUserIndex &&
      message.role === 'assistant' &&
      message.content.trim()
  )
  if (!reply) return null

  const user = ellipsize(
    flat(userMessage.displayContent ?? userMessage.content),
    TITLE_PROMPT_USER_CHARS
  )
  const assistant = ellipsize(flat(reply.content), TITLE_PROMPT_REPLY_CHARS)
  if (!user || !assistant) return null
  return { user, assistant }
}

// one plain chat call collecting the full output; any failure -> null so the
// heuristic title simply stays
export async function requestSessionTitle(
  client: AgentInferenceClient,
  model: string,
  exchange: { user: string; assistant: string },
  signal?: AbortSignal,
  numCtx?: number
): Promise<string | null>
{
  let text = ''
  try
  {
    for await (const chunk of client.chatStream(
      {
        model,
        messages: [
          { role: 'system', content: TITLE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `User: ${exchange.user}\n\nAssistant: ${exchange.assistant}`,
          },
        ],
        // a title is a few words; bound decode regardless of model verbosity
        num_predict: 32,
        // reuse the session pin so this request does not reload the runner
        num_ctx: numCtx,
      },
      signal
    ))
    {
      if (signal?.aborted) return null
      text += chunk.message.content ?? ''
    }
  }
  catch
  {
    return null
  }
  return sanitizeSessionTitle(text)
}

export interface SessionTitleGeneratorDependencies
{
  client: AgentInferenceClient
  // write-back shares the /rename path (store rename + runtime meta update)
  applyTitle: (sessionId: string, title: string) => void
  // applies only while its session is still the active one
  isActiveSession: (sessionId: string) => boolean
}

// at-most-once background titles from the already-loaded local model; every
// path is fire-and-forget and error-swallowing by contract
export class SessionTitleGenerator
{
  private readonly attempted = new Set<string>()
  private readonly pending = new Map<AbortController, Promise<void>>()

  constructor(
    private readonly dependencies: SessionTitleGeneratorDependencies
  )
  {}

  hasAttempted(sessionId: string): boolean
  {
    return this.attempted.has(sessionId)
  }

  // foreground work and shutdown retire the optional background inference
  cancel(): Promise<void>
  {
    for (const controller of this.pending.keys()) controller.abort()
    return Promise.all(this.pending.values()).then(() => undefined)
  }

  // offer a title after an accepted turn settles; never throws & never blocks
  offer(
    meta: SessionMeta,
    model: string,
    signal?: AbortSignal,
    numCtx?: number
  ): void
  {
    if (this.attempted.has(meta.id)) return

    const stored = loadSession(meta.id)
    if (!stored) return

    // only fresh first exchanges earn a generation: exactly one user prompt so
    // far keeps multi-tool openings eligible while resumed sessions skip
    const userPrompts = findUserTurnStarts(stored.messages, stored.undo).length
    if (userPrompts !== 1) return

    // heuristic-only titles are replaceable; explicit /rename wins forever
    if (stored.meta.title !== derivedSessionTitle(stored.messages)) return

    const exchange = extractFirstExchange(stored.messages, stored.undo)
    if (!exchange) return

    this.attempted.add(meta.id)
    const sampledTitle = stored.meta.title
    void this.cancel()
    const controller = new AbortController()
    const titleSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal
    const task = requestSessionTitle(
      this.dependencies.client,
      model,
      exchange,
      titleSignal,
      numCtx
    )
      .then((title) =>
      {
        if (!title || titleSignal.aborted) return
        // re-check right before applying: renames mid-flight always win
        const current = loadSession(meta.id)
        if (!current || current.meta.title !== sampledTitle) return
        if (!this.dependencies.isActiveSession(meta.id)) return
        this.dependencies.applyTitle(meta.id, title)
      })
      .catch(() =>
      {
        // title generation must never disturb the turn loop
      })
      .finally(() =>
      {
        this.pending.delete(controller)
      })
    this.pending.set(controller, task)
  }
}
