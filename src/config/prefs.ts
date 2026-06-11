// src/config/prefs.ts
// user preferences persisted to ~/.coral/prefs.json

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCoralHome } from '../utils/coral-home.js'

export interface Prefs
{
  theme?: string
}

function prefsPath(): string
{
  return join(getCoralHome(), 'prefs.json')
}

// load prefs; missing or corrupt file -> empty prefs
export function loadPrefs(): Prefs
{
  try
  {
    const parsed: unknown = JSON.parse(readFileSync(prefsPath(), 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as Prefs) : {}
  }
  catch
  {
    return {}
  }
}

// merge a patch into prefs on disk & return the result
export function savePrefs(patch: Partial<Prefs>): Prefs
{
  const next = { ...loadPrefs(), ...patch }
  mkdirSync(getCoralHome(), { recursive: true })
  writeFileSync(prefsPath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
