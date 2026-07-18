// src/config/prefs.ts
// mutable user preference persistence

import { coralHomePath } from '../utils/coral-home.js'
import { readJsonObjectFile, writeJsonFile } from '../utils/json.js'

export interface Prefs
{
  theme?: string
}

// load preferences, treating a missing or corrupt file as empty
export function loadPrefs(): Prefs
{
  return (
    (readJsonObjectFile(coralHomePath('prefs.json')) as Prefs | undefined) ?? {}
  )
}

// merge a patch into disk preferences and return the result
export function savePrefs(patch: Partial<Prefs>): Prefs
{
  const next = { ...loadPrefs(), ...patch }
  writeJsonFile(coralHomePath('prefs.json'), next)
  return next
}
