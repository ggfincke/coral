// src/config/prefs.ts
// mutable user preference persistence

import { coralHomePath } from '../utils/coral-home.js'
import { readJsonObjectFile, writeJsonFile } from '../utils/json.js'

export interface Prefs
{
  theme?: string
  // modal editing preference persisted by /vim
  vim?: boolean
  // bell + OSC 9 nudges on turn settle / approval prompts (default on)
  notifications?: boolean
  // raw {action, chord} overrides validated at consumption time
  keybindings?: unknown
}

// expected JSON type of each typed field; keybindings validate at consumption
const PREF_FIELD_TYPES = {
  theme: 'string',
  vim: 'boolean',
  notifications: 'boolean',
} as const

// load preferences, treating a missing or corrupt file as empty and dropping
// hand-edited fields of the wrong type
export function loadPrefs(): Prefs
{
  const prefs = readJsonObjectFile(coralHomePath('prefs.json')) ?? {}
  for (const [key, type] of Object.entries(PREF_FIELD_TYPES))
  {
    if (Object.hasOwn(prefs, key) && typeof prefs[key] !== type)
      delete prefs[key]
  }
  return prefs as Prefs
}

// merge a patch into disk preferences and return the result
export function savePrefs(patch: Partial<Prefs>): Prefs
{
  const next = { ...loadPrefs(), ...patch }
  writeJsonFile(coralHomePath('prefs.json'), next)
  return next
}
