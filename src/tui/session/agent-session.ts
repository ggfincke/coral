// src/tui/session/agent-session.ts
// construct primary Agents and bridge their state to persisted sessions

import { existsSync } from 'node:fs'
import { Agent } from '../../agent/agent.js'
import { AgentTodoState } from '../../agent/state/todos.js'
import type { McpConfigResolution } from '../../config/mcp.js'
import { createSession, loadSession, saveSession } from '../../session/store.js'
import {
  isValidSessionId,
  type SessionData,
  type SessionMeta,
} from '../../session/types.js'

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
  mcp: boolean
  mcpConfig: McpConfigResolution
  restored?: SessionData | null
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
    mcp: options.mcp,
    mcpConfig: options.mcpConfig,
    todoState: new AgentTodoState(options.restored?.todos),
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
