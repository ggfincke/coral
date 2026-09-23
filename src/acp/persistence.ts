// src/acp/persistence.ts
// capture a complete native snapshot before acknowledging a provider turn

import type { Agent } from '../agent/agent.js'
import type { SessionLeaseOwnership } from '../session/lease.js'
import type { ProviderSessionSaveInput } from '../session/store.js'
import type { SessionData } from '../session/types.js'
import { derivedSessionTitle } from '../session/store.js'

export type ProviderTurnSnapshotAgent = Pick<
  Agent,
  | 'exportUndoStateForPersistence'
  | 'getCompactionCount'
  | 'getCwd'
  | 'getLastCompactedAt'
  | 'getMessages'
  | 'getModel'
  | 'getTodos'
>

export function buildProviderTurnSaveInput(
  agent: ProviderTurnSnapshotAgent,
  previous: SessionData,
  lease: SessionLeaseOwnership
): ProviderSessionSaveInput
{
  const messages = agent.getMessages()
  const undoState = agent.exportUndoStateForPersistence()
  const snapshot = structuredClone({
    meta: {
      ...previous.meta,
      model: agent.getModel(),
      cwd: agent.getCwd(),
      title:
        previous.meta.messageCount === 0
          ? derivedSessionTitle(messages)
          : previous.meta.title,
      updatedAt: new Date().toISOString(),
      messageCount: messages.filter((message) => message.role !== 'system')
        .length,
      compactionCount: agent.getCompactionCount(),
      lastCompactedAt: agent.getLastCompactedAt() ?? undefined,
    },
    messages,
    todos: agent.getTodos(),
    ...undoState,
  })
  return { sessionId: previous.meta.id, lease, snapshot }
}
