// src/session/errors.ts
// typed provider persistence failures

export type SessionPersistenceErrorCode =
  | 'invalid_session'
  | 'session_not_found'
  | 'session_in_use'
  | 'lease_not_owned'
  | 'invalid_snapshot'
  | 'create_failed'
  | 'lease_failed'
  | 'save_failed'

export interface SessionPersistenceErrorDetails
{
  sessionId?: string
  cause?: unknown
}

export class SessionPersistenceError extends Error
{
  readonly code: SessionPersistenceErrorCode
  readonly sessionId?: string

  constructor(
    code: SessionPersistenceErrorCode,
    message: string,
    details: SessionPersistenceErrorDetails = {}
  )
  {
    super(
      message,
      details.cause === undefined
        ? undefined
        : {
            cause: details.cause,
          }
    )
    this.name = 'SessionPersistenceError'
    this.code = code
    this.sessionId = details.sessionId
  }
}
