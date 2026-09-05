// src/tui/input/keybindings.ts
// shared keybinding registry for help, palette, and prompt handlers

import {
  buildChordLookup,
  normalizeChord,
  parseKeybindingOverrides,
  type KeybindingOverride,
} from './keybinding-config.js'

export type KeybindingAction =
  | 'toggle-thinking'
  | 'toggle-permissions'
  | 'page-up'
  | 'page-down'
  | 'jump-top'
  | 'jump-bottom'
  | 'half-page-up'
  | 'half-page-down'
  | 'toggle-tool-output'

export interface KeybindingSummary
{
  keys: string
  description: string
  action?: KeybindingAction
}

// prompt-only handlers that are wired but not palette-runnable
export type PromptKeybinding = KeybindingAction | 'open-palette' | 'open-editor'

// minimal key shape so this module stays free of CoralKey
export interface KeybindingKey
{
  ctrl: boolean
  pageUp: boolean
  pageDown: boolean
  meta?: boolean
  shift?: boolean
  home?: boolean
  end?: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  return?: boolean
  tab?: boolean
  backspace?: boolean
  delete?: boolean
  escape?: boolean
  functionKey?: string
}

// single source for advertised bindings and PromptInput matchers
export const KEYBINDINGS: readonly KeybindingSummary[] = [
  {
    keys: 'ctrl+p',
    description: 'Open command palette',
  },
  {
    keys: 'ctrl+y',
    description: 'Toggle permission mode (ask / yolo)',
    action: 'toggle-permissions',
  },
  {
    keys: 'ctrl+t',
    description: 'Toggle thinking/reasoning visibility',
    action: 'toggle-thinking',
  },
  {
    keys: 'ctrl+c',
    description: 'Interrupt generation (or exit when idle)',
  },
  {
    keys: 'esc',
    description: 'Interrupt generation (or exit when idle)',
  },
  {
    keys: '↑↓',
    description: 'Move cursor / navigate input history',
  },
  {
    keys: 'ctrl+r',
    description: 'Reverse-search input history',
  },
  {
    keys: 'ctrl+j / meta+enter',
    description: 'Insert newline',
  },
  {
    keys: '\\ + enter',
    description: 'Continue draft on a new line',
  },
  {
    keys: 'ctrl+w / ctrl+u / ctrl+k',
    description: 'Kill word / to line start / to line end',
  },
  {
    keys: 'ctrl+v',
    description: 'Yank last kill (meta+y cycles)',
  },
  {
    keys: 'ctrl+_',
    description: 'Undo prompt edit',
  },
  {
    keys: 'ctrl+o',
    description: 'Expand/collapse newest tool output',
  },
  {
    keys: 'ctrl+g',
    description: 'Compose the draft in $EDITOR',
  },
  {
    keys: 'meta+backspace',
    description: 'Edit newest queued message (when composer is empty)',
  },
  {
    keys: 'pgup/dn',
    description: 'Page through transcript',
  },
  {
    keys: 'meta+↑↓ / ctrl+home·end',
    description: 'Half-page / jump transcript',
  },
]

export function keybindingInfos(): KeybindingSummary[]
{
  return KEYBINDINGS.map((binding) => ({ ...binding }))
}

export function matchPromptKeybinding(
  input: string,
  key: KeybindingKey
): PromptKeybinding | undefined
{
  if (key.pageUp) return 'page-up'
  if (key.pageDown) return 'page-down'
  // transcript jumps: ctrl+home/end & meta+arrows stay clear of composer keys
  if (key.ctrl && key.home) return 'jump-top'
  if (key.ctrl && key.end) return 'jump-bottom'
  if (key.meta && key.upArrow) return 'half-page-up'
  if (key.meta && key.downArrow) return 'half-page-down'
  if (!key.ctrl) return undefined

  const letter = input.toLowerCase()
  if (letter === 't') return 'toggle-thinking'
  if (letter === 'y') return 'toggle-permissions'
  if (letter === 'p') return 'open-palette'
  if (letter === 'o') return 'toggle-tool-output'
  // ctrl+g is the readline convention for "edit in external editor"
  if (letter === 'g') return 'open-editor'
  return undefined
}

const NAVIGABLE_KEYS: ReadonlySet<string> = new Set([
  'pageup',
  'pagedown',
  'home',
  'end',
  'up',
  'down',
  'left',
  'right',
])

// actions an override may target; anything else in prefs is ignored here so a
// typo can never hijack composer input
const OVERRIDABLE_ACTIONS: ReadonlySet<string> = new Set([
  'toggle-thinking',
  'toggle-permissions',
  'page-up',
  'page-down',
  'jump-top',
  'jump-bottom',
  'half-page-up',
  'half-page-down',
  'toggle-tool-output',
  'open-palette',
  'open-editor',
])

// raw chord from the live event; normalizeChord canonicalizes the result, so
// '+' as final key rides the trailing-separator form ('ctrl++')
export function chordFromEvent(
  input: string,
  key: KeybindingKey
): string | null
{
  const mods: string[] = []
  if (key.ctrl) mods.push('ctrl')
  if (key.meta) mods.push('meta')
  if (key.shift) mods.push('shift')

  let base: string | null = null
  if (key.pageUp) base = 'pageup'
  else if (key.pageDown) base = 'pagedown'
  else if (key.home) base = 'home'
  else if (key.end) base = 'end'
  else if (key.upArrow) base = 'up'
  else if (key.downArrow) base = 'down'
  else if (key.leftArrow) base = 'left'
  else if (key.rightArrow) base = 'right'
  else if (key.return) base = 'enter'
  else if (key.tab) base = 'tab'
  else if (key.backspace) base = 'backspace'
  else if (key.delete) base = 'delete'
  else if (key.escape) base = 'escape'
  else if (key.functionKey) base = key.functionKey
  else if (input === ' ') base = 'space'
  else if (input.length === 1 && input !== '') base = input

  if (base === null) return null

  // unmodified printable keys stay reserved for typing
  if (mods.length === 0 && !NAVIGABLE_KEYS.has(base) && !key.functionKey)
    return null

  return [...mods, base].join('+')
}

// session chord overrides win before matchPromptKeybinding; unknown actions
// and malformed chords fall through to defaults untouched
export function resolveOverrideAction(
  input: string,
  key: KeybindingKey,
  overrides?: ReadonlyMap<string, string>
): PromptKeybinding | undefined
{
  if (!overrides || overrides.size === 0) return undefined

  const raw = chordFromEvent(input, key)
  if (raw === null) return undefined

  const canonical = normalizeChord(raw)
  if (canonical === null) return undefined

  const action = overrides.get(canonical)
  if (action !== undefined && OVERRIDABLE_ACTIONS.has(action))
  {
    return action as PromptKeybinding
  }
  return undefined
}

// keep structural parsing reusable; runtime consumption additionally rejects
// actions and chords the composer cannot honor
export function resolveKeybindingConfig(raw: unknown): {
  overrides: KeybindingOverride[]
  lookup: Map<string, string>
  conflicts: string[]
  errors: string[]
}
{
  const parsed = parseKeybindingOverrides(raw ?? [])
  const overrides: KeybindingOverride[] = []
  const errors = [...parsed.errors]
  for (const entry of parsed.overrides)
  {
    const chord = normalizeChord(entry.chord)
    if (!OVERRIDABLE_ACTIONS.has(entry.action))
    {
      errors.push(`unknown keybinding action: ${entry.action}`)
      continue
    }
    if (
      chord === null ||
      (!chord.includes('+') &&
        !NAVIGABLE_KEYS.has(chord) &&
        !/^f(?:[1-9]|1[0-2])$/.test(chord))
    )
    {
      errors.push(`unsupported keybinding chord: ${entry.chord}`)
      continue
    }
    if (chord === 'ctrl+c' || chord === 'ctrl+z')
    {
      errors.push(`reserved keybinding chord: ${entry.chord}`)
      continue
    }
    overrides.push({ action: entry.action, chord })
  }
  return { overrides, ...buildChordLookup(overrides), errors }
}
