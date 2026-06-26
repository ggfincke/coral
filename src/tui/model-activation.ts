// src/tui/model-activation.ts
// model picker restore sentinels

import type { SessionData } from '../session/store.js'

export function restoredSessionForPickerSelection(
  hasExistingAgent: boolean,
  resumeSession: SessionData | null
): SessionData | null
{
  return hasExistingAgent ? null : resumeSession
}
