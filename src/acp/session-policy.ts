// src/acp/session-policy.ts
// expose ACP interaction & runtime permission modes and their approval policy

import type {
  SessionConfigOption,
  SessionModeState,
  SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk/unstable'
import { invalidAcpParams } from './errors.js'

// ids match the client's runtime modes verbatim
export type CoralRuntimeMode =
  'approval-required' | 'auto-accept-edits' | 'full-access'
export type CoralInteractionMode = 'default'
export const CORAL_RUNTIME_MODE_CONFIG_ID = 'coral.runtime-mode'

const RUNTIME_MODES: ReadonlyArray<{ value: CoralRuntimeMode; name: string }> =
  [
    { value: 'approval-required', name: 'Supervised' },
    { value: 'auto-accept-edits', name: 'Auto-accept edits' },
    { value: 'full-access', name: 'Full access' },
  ]

const EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file'])

export function buildInteractionModes(
  currentModeId: CoralInteractionMode
): SessionModeState
{
  return { currentModeId, availableModes: [{ id: 'default', name: 'Default' }] }
}

export function selectedInteractionMode(modeId: string): CoralInteractionMode
{
  if (modeId !== 'default')
    throw invalidAcpParams(`Unsupported Coral session mode: ${modeId}`)
  return modeId
}

export function buildRuntimeModeConfigOption(
  currentValue: CoralRuntimeMode
): SessionConfigOption
{
  return {
    id: CORAL_RUNTIME_MODE_CONFIG_ID,
    name: 'Runtime mode',
    category: 'mode',
    type: 'select',
    currentValue,
    options: RUNTIME_MODES.map((mode) => ({ ...mode })),
  }
}

export function isRuntimeModeConfigRequest(
  request: SetSessionConfigOptionRequest
): boolean
{
  return request.configId === CORAL_RUNTIME_MODE_CONFIG_ID
}

export function selectedRuntimeMode(
  request: SetSessionConfigOptionRequest
): CoralRuntimeMode
{
  const mode =
    isRuntimeModeConfigRequest(request) && !('type' in request)
      ? RUNTIME_MODES.find((entry) => entry.value === request.value)?.value
      : undefined
  if (!mode)
  {
    throw invalidAcpParams(
      `Unsupported Coral runtime mode: ${String(request.value)}`
    )
  }
  return mode
}

// decide whether a mode approves a call that already reached approval;
// always_deny never gets here, so no mode can override it. auto-accept-edits
// covers only in-workspace file edits, & full-access matches TUI yolo
export function runtimeModeAutoApproves(
  mode: CoralRuntimeMode,
  toolName: string,
  crossesWorkspace: boolean
): boolean
{
  if (mode === 'full-access') return true
  if (mode === 'auto-accept-edits')
    return EDIT_TOOLS.has(toolName) && !crossesWorkspace
  return false
}
