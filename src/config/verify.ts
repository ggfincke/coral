// src/config/verify.ts
// post-edit verification config parsing

import { loadProjectConfig } from './project-config.js'
import { isPlainObject } from '../utils/guards.js'

export interface VerifyConfig
{
  enabled: boolean
}

// resolve the per-Agent verification setting without coercing malformed values
export function resolveVerifyConfig(cwd: string): VerifyConfig
{
  const raw = loadProjectConfig(cwd).verify
  return {
    enabled:
      isPlainObject(raw) && typeof raw.enabled === 'boolean'
        ? raw.enabled
        : false,
  }
}
