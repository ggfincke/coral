// src/acp/errors.ts
// stable ACP request errors and bounded diagnostics

import { RequestError } from '@agentclientprotocol/sdk'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'

export type CoralAcpErrorCode =
  | 'invalid_session'
  | 'session_busy'
  | 'session_in_use'
  | 'session_not_found'
  | 'session_not_bound'
  | 'session_persistence_failed'
  | 'unsupported_capability'

const CORAL_ACP_ERROR_CODE = -32000
const MAX_DIAGNOSTIC_CHARS = 2_000

export function coralAcpError(
  code: CoralAcpErrorCode,
  message: string
): RequestError
{
  return new RequestError(CORAL_ACP_ERROR_CODE, message, { code })
}

export function invalidAcpParams(message: string): RequestError
{
  return RequestError.invalidParams(undefined, message)
}

export function boundedDiagnostic(error: unknown): string
{
  const message =
    error instanceof Error ? error.message : String(error ?? 'Unknown error')
  const sanitized = sanitizeUntrustedText(message)
  if (sanitized.length <= MAX_DIAGNOSTIC_CHARS) return sanitized
  return `${sanitized.slice(0, MAX_DIAGNOSTIC_CHARS)}...`
}
