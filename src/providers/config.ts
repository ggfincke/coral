// src/providers/config.ts
// hosted provider credentials and user-only tuning

import { loadUserConfig } from '../config/project-config.js'
import { isPlainObject } from '../utils/guards.js'
import type { HostedProvider } from './model-ref.js'

export type HostedEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface HostedProviderSettings
{
  apiKey: string
  effort: HostedEffort
  // window ceiling; resent history makes it the per-turn cost cap
  maxContextTokens: number
}

const API_KEY_ENV: Record<HostedProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
}

export const DEFAULT_HOSTED_EFFORT: HostedEffort = 'high'
export const DEFAULT_HOSTED_MAX_CONTEXT_TOKENS = 200_000

const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])

export function apiKeyEnvName(provider: HostedProvider): string
{
  return API_KEY_ENV[provider]
}

export function hasHostedCredentials(provider: HostedProvider): boolean
{
  return Boolean(process.env[API_KEY_ENV[provider]]?.trim())
}

// read ~/.coral.json providers.<name>; malformed fields fall back to defaults
export function resolveHostedSettings(
  provider: HostedProvider
): HostedProviderSettings
{
  const apiKey = process.env[API_KEY_ENV[provider]]?.trim()
  if (!apiKey)
  {
    throw new Error(
      `${API_KEY_ENV[provider]} is not set; export it to use ${provider}/ models`
    )
  }

  const providers = loadUserConfig().providers
  const raw = isPlainObject(providers) ? providers[provider] : undefined
  const section = isPlainObject(raw) ? raw : {}
  const effort =
    typeof section.effort === 'string' && EFFORTS.has(section.effort)
      ? (section.effort as HostedEffort)
      : DEFAULT_HOSTED_EFFORT
  const maxContextTokens =
    typeof section.maxContextTokens === 'number' &&
    Number.isFinite(section.maxContextTokens) &&
    section.maxContextTokens > 0
      ? Math.floor(section.maxContextTokens)
      : DEFAULT_HOSTED_MAX_CONTEXT_TOKENS

  return { apiKey, effort, maxContextTokens }
}
