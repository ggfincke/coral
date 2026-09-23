// src/acp/session-policy.ts
// expose only the supervised ACP policy supported by this integration

import type {
  SessionConfigOption,
  SessionModeState,
  SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk'
import { invalidAcpParams } from './errors.js'

export type CoralRuntimeMode = 'approval-required'
export type CoralInteractionMode = 'default'
export const CORAL_RUNTIME_MODE_CONFIG_ID = 'coral.runtime-mode'

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
    options: [{ value: 'approval-required', name: 'Approval required' }],
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
  if (
    !isRuntimeModeConfigRequest(request) ||
    'type' in request ||
    request.value !== 'approval-required'
  )
  {
    throw invalidAcpParams(
      'Coral ACP supports only approval-required runtime mode'
    )
  }
  return request.value
}
