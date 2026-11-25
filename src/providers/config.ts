// src/providers/config.ts
// hosted provider credentials and user-only tuning

import { MIN_NUM_CTX } from '../config/context.js'
import { loadUserConfig } from '../config/project-config.js'
import { isPlainObject, positiveInteger } from '../utils/guards.js'
import { execFileCommand } from '../utils/process.js'
import type { HostedProvider } from './model-ref.js'

export type HostedEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface HostedProviderSettings
{
  apiKey: string
  // where the key came from, named when the provider rejects it
  apiKeySource: string
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

interface ResolvedApiKey
{
  key: string
  source: string
}

// environment keys take precedence; linux desktop keys use the user's keyring
async function resolveApiKey(
  provider: HostedProvider
): Promise<ResolvedApiKey | undefined>
{
  const envName = API_KEY_ENV[provider]
  const envKey = process.env[envName]?.trim()
  if (envKey) return { key: envKey, source: envName }
  if (process.platform !== 'linux') return undefined

  const result = await execFileCommand(
    'secret-tool',
    ['lookup', 'application', 'coral', 'provider', provider],
    { timeout: 2_000, maxBuffer: 16_384 }
  )
  const key = result.ok ? result.stdout.trim() : ''
  return key
    ? { key, source: `the keyring (application coral, provider ${provider})` }
    : undefined
}

export async function hasHostedCredentials(
  provider: HostedProvider
): Promise<boolean>
{
  return (await resolveApiKey(provider)) !== undefined
}

// read ~/.coral.json providers.<name>; malformed fields fall back to defaults
export async function resolveHostedSettings(
  provider: HostedProvider
): Promise<HostedProviderSettings>
{
  const credential = await resolveApiKey(provider)
  if (!credential)
  {
    throw new Error(
      `${API_KEY_ENV[provider]} is not set and no keyring credential was found for ${provider}/ models`
    )
  }

  const providers = loadUserConfig().providers
  const raw = isPlainObject(providers) ? providers[provider] : undefined
  const section = isPlainObject(raw) ? raw : {}
  const effort =
    typeof section.effort === 'string' && EFFORTS.has(section.effort)
      ? (section.effort as HostedEffort)
      : DEFAULT_HOSTED_EFFORT
  // a ceiling below the minimum window would leave too little room to work
  const maxContextTokens = Math.max(
    MIN_NUM_CTX,
    positiveInteger(section.maxContextTokens) ??
      DEFAULT_HOSTED_MAX_CONTEXT_TOKENS
  )

  return {
    apiKey: credential.key,
    apiKeySource: credential.source,
    effort,
    maxContextTokens,
  }
}
