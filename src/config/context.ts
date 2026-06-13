// src/config/context.ts
// model context-window sizing config

import { loadProjectConfig } from './permissions.js'

// default ceiling for the pinned num_ctx — caps KV-cache memory while still
// giving large models a workable window. raise via .coral.json or CORAL_NUM_CTX
// on big-RAM hosts to use more of a 128K-capable model's window
const DEFAULT_MAX_NUM_CTX = 32_768

export interface ContextConfig
{
  maxNumCtx: number
}

// resolve the num_ctx ceiling — env wins, then .coral.json, then the default
export function resolveContextConfig(cwd: string): ContextConfig
{
  const configured = loadProjectConfig(cwd).context?.maxNumCtx
  const fromConfig =
    typeof configured === 'number' && configured > 0
      ? Math.floor(configured)
      : 0

  const env = Number.parseInt(process.env.CORAL_NUM_CTX ?? '', 10)
  const fromEnv = Number.isFinite(env) && env > 0 ? env : 0

  return { maxNumCtx: fromEnv || fromConfig || DEFAULT_MAX_NUM_CTX }
}
