// src/tui/use-session-persistence.ts
// session restore/persist helpers for the TUI shell

import { useCallback, useRef, type MutableRefObject } from 'react'
import { getCwd } from '../cwd.js'
import type { Agent } from '../agent/agent.js'
import {
  createSession,
  loadSession,
  saveSession,
  type SessionData,
  type SessionMeta,
} from '../session/store.js'

// cache resume metadata in-memory so each turn avoids disk round-trips
export function useSessionPersistence(resumeSessionId?: string): {
  sessionIdRef: MutableRefObject<string | null>
  sessionMetaRef: MutableRefObject<SessionMeta | null>
  getResumeSession: () => SessionData | null
  persistSession: (agent: Agent) => SessionMeta | null
}
{
  const sessionIdRef = useRef<string | null>(resumeSessionId ?? null)
  const sessionMetaRef = useRef<SessionMeta | null>(null)
  const resumeSessionRef = useRef<SessionData | null | undefined>(undefined)

  const getResumeSession = useCallback((): SessionData | null =>
  {
    if (!resumeSessionId) return null

    if (resumeSessionRef.current === undefined)
    {
      const session = loadSession(resumeSessionId)
      resumeSessionRef.current = session

      if (session)
      {
        sessionIdRef.current = session.meta.id
        sessionMetaRef.current = session.meta
      }
    }

    return resumeSessionRef.current ?? null
  }, [resumeSessionId])

  const persistSession = useCallback((agent: Agent) =>
  {
    try
    {
      const messages = agent.getMessages()
      const model = agent.getModel()
      const cwd = getCwd()
      const metaHint = sessionMetaRef.current
        ? {
            createdAt: sessionMetaRef.current.createdAt,
            title: sessionMetaRef.current.title,
            compactionCount: agent.getCompactionCount(),
            lastCompactedAt: agent.getLastCompactedAt() ?? undefined,
          }
        : {
            compactionCount: agent.getCompactionCount(),
            lastCompactedAt: agent.getLastCompactedAt() ?? undefined,
          }

      const meta = sessionIdRef.current
        ? saveSession(sessionIdRef.current, model, cwd, messages, metaHint)
        : createSession(model, cwd, messages)

      sessionIdRef.current = meta.id
      sessionMetaRef.current = meta
      return meta
    }
    catch
    {
      // session save failure is non-fatal
      return null
    }
  }, [])

  return {
    sessionIdRef,
    sessionMetaRef,
    getResumeSession,
    persistSession,
  }
}
