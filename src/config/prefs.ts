// src/config/prefs.ts
// user preferences persisted to ~/.coral/prefs.json

import { join } from 'node:path'
import { getCoralHome } from '../utils/coral-home.js'
import { readJsonObjectFile, writeJsonFile } from '../utils/json.js'

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
  return (readJsonObjectFile(prefsPath()) as Prefs | undefined) ?? {}
}

// merge a patch into prefs on disk & return the result
export function savePrefs(patch: Partial<Prefs>): Prefs
{
  const next = { ...loadPrefs(), ...patch }
  writeJsonFile(prefsPath(), next)
  return next
}
