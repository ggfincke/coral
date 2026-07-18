// tests/helpers/session.ts
// create SessionMeta & SessionData fixtures for node:test files

import type { SessionData, SessionMeta } from '../../src/session/types.js'

export function makeSessionMeta(
  overrides: Partial<SessionMeta> = {}
): SessionMeta
{
  const id = overrides.id ?? 'abcd1234'
  return {
    id,
    model: 'test-model',
    cwd: '/tmp/test-project',
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    title: `Session ${id}`,
    messageCount: 2,
    ...overrides,
  }
}

export function makeSessionData(
  metaOverrides: Partial<SessionMeta> = {}
): SessionData
{
  const meta = makeSessionMeta(metaOverrides)
  return {
    meta,
    messages: [
      { role: 'system', content: 'System' },
      { role: 'user', content: meta.title },
    ],
  }
}
