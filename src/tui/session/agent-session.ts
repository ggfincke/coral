// src/tui/session/agent-session.ts
// construct primary Agents and bridge their state to persisted sessions

import { existsSync } from 'node:fs'
import { Agent } from '../../agent/agent.js'
import type { AgentInferenceClient } from '../../agent/inference-client.js'
import { AgentTodoState } from '../../agent/state/todos.js'
import type { McpConfigResolution } from '../../config/mcp.js'
import { resolveDualResidencyWeightBytes } from '../../inference/embedding-weights.js'
import { parseModelRef } from '../../inference/model-ref.js'
import { resolveInferenceClient } from '../../inference/resolve-client.js'
import type { WorkerSupervisor } from '../../inference/worker-supervisor.js'
import type { McpMode } from '../../mcp/types.js'
import { OllamaClient } from '../../ollama/client.js'
import {
  canonicalEmbeddingModel,
  resolveRetrievalConfig,
} from '../../retrieval/config.js'
import { createSession, loadSession, saveSession } from '../../session/store.js'
import {
  isValidSessionId,
  type SessionData,
  type SessionMeta,
} from '../../session/types.js'
import { createRetrievalDeps } from '../../tools/search-code-deps.js'
import { agentsHomePath } from '../../utils/agents-home.js'
import { discoverSkills, loadUserInstructions } from '../../skills/discover.js'

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
  worker?: WorkerSupervisor
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
  const ref = parseModelRef(options.model)
  const cwd = options.cwd
  const ollama = new OllamaClient(options.host)
  const inferenceClient =
    options.inferenceClient ??
    resolveInferenceClient(ref, {
      ollama,
      worker: options.worker,
    })
  const retrievalDeps = createRetrievalDeps({ worker: options.worker })
  const agentsHome = agentsHomePath()
  const skills = discoverSkills({
    cwd: cwd ?? process.cwd(),
    agentsHome,
  })
  const agent = new Agent(ref.canonical, options.host, cwd, {
    think: options.think,
    mcpMode: options.mcpMode,
    mcpConfig: options.mcpConfig,
    todoState: new AgentTodoState(options.restored?.todos),
    inferenceClient,
    retrievalDeps,
    skills,
    userInstructions: loadUserInstructions(agentsHome),
    extraWeightBytes: (model, signal) =>
    {
      const chat = parseModelRef(model)
      return resolveDualResidencyWeightBytes({
        chatBackend: chat.backend,
        chatModel: chat.model,
        embedModel: canonicalEmbeddingModel(
          resolveRetrievalConfig(cwd ?? process.cwd())
        ),
        listOllamaModels: (requestSignal) => ollama.listModels(requestSignal),
        worker: options.worker,
        signal,
      })
    },
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
