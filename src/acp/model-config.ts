// src/acp/model-config.ts
// build and validate Coral's standard ACP model selector

import type {
  SessionConfigOption,
  SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk'
import type { Model } from '../types/inference.js'
import { invalidAcpParams } from './errors.js'

export const CORAL_MODEL_CONFIG_ID = 'model'
export const DEFAULT_ACP_MODEL = 'gemma4:31b-mlx'

function modifiedAt(model: Model): number
{
  const timestamp = Date.parse(model.modified_at)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function availableModelNames(models: readonly Model[]): string[]
{
  const byName = new Map<string, Model>()
  for (const model of models)
  {
    const name = model.name.trim()
    if (name && !byName.has(name)) byName.set(name, model)
  }

  return [...byName.values()]
    .sort((left, right) =>
    {
      const leftDefault = left.name === DEFAULT_ACP_MODEL
      const rightDefault = right.name === DEFAULT_ACP_MODEL
      if (leftDefault !== rightDefault) return leftDefault ? -1 : 1

      const dateDifference = modifiedAt(right) - modifiedAt(left)
      if (dateDifference !== 0) return dateDifference
      return left.name.localeCompare(right.name)
    })
    .map((model) => model.name)
}

export function buildModelConfigOption(
  currentModel: string,
  availableModels: readonly string[]
): SessionConfigOption
{
  const names = [currentModel, ...availableModels].filter(
    (name, index, values) => name && values.indexOf(name) === index
  )
  return {
    id: CORAL_MODEL_CONFIG_ID,
    name: 'Model',
    description: 'Ollama model used for this Coral session',
    category: 'model',
    type: 'select',
    currentValue: currentModel,
    options: names.map((name) => ({ value: name, name })),
  }
}

export function selectedModelFromRequest(
  request: SetSessionConfigOptionRequest,
  availableModels: readonly string[]
): string
{
  if (request.configId !== CORAL_MODEL_CONFIG_ID)
  {
    throw invalidAcpParams(
      `Unsupported session configuration option: ${request.configId}`
    )
  }
  if ('type' in request)
  {
    throw invalidAcpParams('The model configuration requires a select value')
  }
  if (!availableModels.includes(request.value))
  {
    throw invalidAcpParams(`Unknown Ollama model: ${request.value}`)
  }
  return request.value
}
