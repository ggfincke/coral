// src/config/inference.ts
// user-level inference worker paths; env wins over ~/.coral.json

import { isPlainObject } from '../utils/guards.js'
import { loadUserConfig } from './project-config.js'

export interface InferenceUserConfig
{
  python?: string
  mlxModelsDir?: string
}

function nonemptyString(value: unknown): string | undefined
{
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

// resolve machine-local inference paths; env overrides JSON
export function resolveInferenceConfig(): InferenceUserConfig
{
  const raw = loadUserConfig().inference
  const json = isPlainObject(raw) ? raw : {}
  const python =
    nonemptyString(process.env.CORAL_PYTHON) ?? nonemptyString(json.python)
  const mlxModelsDir =
    nonemptyString(process.env.CORAL_MLX_MODELS_DIR) ??
    nonemptyString(json.mlxModelsDir)
  const result: InferenceUserConfig = {}
  if (python) result.python = python
  if (mlxModelsDir) result.mlxModelsDir = mlxModelsDir
  return result
}

export function formatWorkerInstallError(detail?: string): string
{
  const lines = [
    'MLX inference requires the Coral Python worker, which is not available.',
  ]
  if (detail) lines.push(detail)
  lines.push(
    'From the Coral checkout, install and sync it with:',
    '  uv sync --project packages/coral-backend',
    'Then launch with:',
    '  uv run --project packages/coral-backend python -m coral_backend',
    'Or set CORAL_PYTHON to a standard CPython 3.14 interpreter after syncing that project.',
    'Use CPython 3.14 (not 3.13 or 3.14t); mlx wheels are cp314-only.',
    'Put MLX weights in CORAL_MLX_MODELS_DIR or inference.mlxModelsDir in ~/.coral.json.'
  )
  return lines.join('\n')
}
