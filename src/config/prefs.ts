// src/config/prefs.ts
// mutable user prefs in ~/.coral/prefs.json (distinct from read-only .coral.json loaders)

import { coralHomePath } from '../utils/coral-home.js'
import { readJsonObjectFile, writeJsonFile } from '../utils/json.js'

export interface Prefs
{
  theme?: string
}

// load prefs; missing or corrupt file -> empty prefs
export function loadPrefs(): Prefs
{
  return (
    (readJsonObjectFile(coralHomePath('prefs.json')) as Prefs | undefined) ?? {}
  )
}

// merge a patch into prefs on disk & return the result
export function savePrefs(patch: Partial<Prefs>): Prefs
{
  const next = { ...loadPrefs(), ...patch }
  writeJsonFile(coralHomePath('prefs.json'), next)
  return next
}
