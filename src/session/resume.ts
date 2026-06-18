// src/session/resume.ts
// session resume target resolution

import {
  listSessions,
  loadSession,
  type SessionData,
  type SessionMeta,
} from './store.js'

export type ResumeSessionResolution =
  | { type: 'target'; session: SessionMeta }
  | { type: 'current'; session: SessionMeta }
  | { type: 'empty' }
  | { type: 'not_found'; requestedId: string }
  | { type: 'ambiguous'; requestedId: string; matches: SessionMeta[] }

export interface ResolveResumeSessionOptions
{
  requestedId?: string
  currentSessionId?: string | null
  allowPrefix?: boolean
}

export interface ResolveResumeSessionCandidatesOptions extends ResolveResumeSessionOptions
{
  sessions: SessionMeta[]
  loadSessionById?: (id: string) => SessionData | null
}

function asResolution(
  session: SessionMeta,
  currentSessionId: string | null | undefined
): ResumeSessionResolution
{
  return session.id === currentSessionId
    ? { type: 'current', session }
    : { type: 'target', session }
}

export function resolveResumeSessionFromCandidates({
  requestedId,
  currentSessionId,
  allowPrefix = false,
  sessions,
  loadSessionById = loadSession,
}: ResolveResumeSessionCandidatesOptions): ResumeSessionResolution
{
  const normalizedId = requestedId?.trim() ?? ''

  if (!normalizedId)
  {
    const latest = sessions.find((session) => session.id !== currentSessionId)
    return latest ? { type: 'target', session: latest } : { type: 'empty' }
  }

  const exact = sessions.find((session) => session.id === normalizedId)
  if (exact) return asResolution(exact, currentSessionId)

  const onDisk = loadSessionById(normalizedId)
  if (onDisk?.meta) return asResolution(onDisk.meta, currentSessionId)

  if (allowPrefix)
  {
    const matches = sessions.filter((session) =>
      session.id.startsWith(normalizedId)
    )

    if (matches.length === 1) return asResolution(matches[0]!, currentSessionId)
    if (matches.length > 1)
    {
      return { type: 'ambiguous', requestedId: normalizedId, matches }
    }
  }

  return { type: 'not_found', requestedId: normalizedId }
}

export function resolveResumeSession(
  options: ResolveResumeSessionOptions = {}
): ResumeSessionResolution
{
  return resolveResumeSessionFromCandidates({
    ...options,
    sessions: listSessions(),
  })
}
