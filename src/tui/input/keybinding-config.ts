// src/tui/input/keybinding-config.ts
// pure parsing & validation for user keybinding override config

export interface KeybindingOverride
{
  action: string
  chord: string
}

export interface ParsedKeybindingConfig
{
  overrides: KeybindingOverride[]
  errors: string[]
}

// hard cap so a hostile config cannot flood the error surface
const MAX_PARSE_ERRORS = 10

// canonical output order for modifiers; input alt folds into meta
const MODIFIER_ORDER: readonly string[] = ['ctrl', 'meta', 'shift']
const MODIFIER_INPUTS: readonly string[] = ['ctrl', 'shift', 'meta', 'alt']

// multi-char finals allowed as-is; single-char finals bypass this set
const NAMED_KEYS: readonly string[] = [
  'enter',
  'tab',
  'backspace',
  'delete',
  'escape',
  'space',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
]

function describeType(value: unknown): string
{
  if (value === null)
  {
    return 'null'
  }
  if (Array.isArray(value))
  {
    return 'array'
  }
  return typeof value
}

// structural validation only: shape & field types; chord syntax is
// normalizeChord's job and stays out of parse errors on purpose
export function parseKeybindingOverrides(raw: unknown): ParsedKeybindingConfig
{
  const overrides: KeybindingOverride[] = []
  const errors: string[] = []

  if (!Array.isArray(raw))
  {
    errors.push(
      `keybinding overrides must be an array, got ${describeType(raw)}`
    )
    return { overrides, errors }
  }

  for (let index = 0; index < raw.length; index++)
  {
    if (errors.length >= MAX_PARSE_ERRORS)
    {
      break
    }

    const entry = raw[index]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
    {
      errors.push(`override #${index + 1} must be an object`)
      continue
    }

    const record = entry as Record<string, unknown>
    if (typeof record.action !== 'string')
    {
      errors.push(`override #${index + 1} needs a string "action"`)
    }
    if (typeof record.chord !== 'string')
    {
      errors.push(`override #${index + 1} needs a string "chord"`)
    }
    if (typeof record.action === 'string' && typeof record.chord === 'string')
    {
      overrides.push({ action: record.action, chord: record.chord })
    }
  }

  return { overrides, errors }
}

// fold input modifiers to canonical names in fixed output order;
// any unknown or misplaced token fails closed
function canonicalizeModifiers(tokens: readonly string[]): string[] | null
{
  const seen: string[] = []

  for (const token of tokens)
  {
    if (!MODIFIER_INPUTS.includes(token))
    {
      return null
    }
    const canonical = token === 'alt' ? 'meta' : token
    if (!seen.includes(canonical))
    {
      seen.push(canonical)
    }
  }

  return MODIFIER_ORDER.filter((mod) => seen.includes(mod))
}

// canonical form joins ctrl/meta/shift then the key with '+', e.g.
// 'ctrl+meta+k'; returns null for empty, modifier-only, or
// multi-char-unnamed finals such as 'ab' or 'f13'
export function normalizeChord(chord: string): string | null
{
  const lowered = chord.trim().toLowerCase()
  if (lowered.length === 0)
  {
    return null
  }

  let finalKey: string
  let modifierTokens: readonly string[]

  // trailing separator denotes the literal '+' / '-' final key,
  // so 'ctrl++' binds ctrl to '+'
  if (lowered.endsWith('+') || lowered.endsWith('-'))
  {
    finalKey = lowered.charAt(lowered.length - 1)
    const parts = lowered.slice(0, -1).split(/[+-]/)
    // only one empty part is legal here: the separator before that literal key
    if (parts.slice(0, -1).includes(''))
    {
      return null
    }
    modifierTokens = parts[parts.length - 1] === '' ? parts.slice(0, -1) : parts
  }
  else
  {
    const parts = lowered.split(/[+-]/)
    // empty parts anywhere mean doubled or leading separators -> malformed
    if (parts.slice(0, -1).includes('') || parts[parts.length - 1] === '')
    {
      return null
    }
    finalKey = parts[parts.length - 1]
    modifierTokens = parts.slice(0, -1)
  }

  const modifiers = canonicalizeModifiers(modifierTokens)
  if (modifiers === null)
  {
    return null
  }
  // modifier-only chords fail because their final token is neither a
  // single char nor a named key
  if (finalKey.length !== 1 && !NAMED_KEYS.includes(finalKey))
  {
    return null
  }

  return [...modifiers, finalKey].join('+')
}

// map canonical chord -> action; later duplicates win while differing
// predecessors are reported as conflicts; chords that fail normalization
// are wiring problems and are skipped silently here
export function buildChordLookup(overrides: readonly KeybindingOverride[]): {
  lookup: Map<string, string>
  conflicts: string[]
}
{
  const lookup = new Map<string, string>()
  const conflicts: string[] = []

  for (const { action, chord } of overrides)
  {
    const canonical = normalizeChord(chord)
    if (canonical === null)
    {
      continue
    }
    const existing = lookup.get(canonical)
    if (existing === undefined || existing === action)
    {
      lookup.set(canonical, action)
      continue
    }
    conflicts.push(`${canonical} bound to both ${existing} and ${action}`)
    lookup.set(canonical, action)
  }

  return { lookup, conflicts }
}
