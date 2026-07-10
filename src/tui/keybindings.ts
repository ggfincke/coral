// src/tui/keybindings.ts
// shared keybinding registry for help, palette, & prompt handlers

export type KeybindingAction =
  | 'toggle-thinking'
  | 'toggle-permissions'
  | 'page-up'
  | 'page-down'

export interface KeybindingSummary
{
  keys: string
  description: string
  action?: KeybindingAction
}

// prompt-only handlers that are wired but not palette-runnable
export type PromptKeybinding = KeybindingAction | 'open-palette'

// minimal key shape so this module stays free of CoralKey
export interface KeybindingKey
{
  ctrl: boolean
  pageUp: boolean
  pageDown: boolean
}

// single source for advertised bindings & PromptInput matchers
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
    description: 'Navigate input history',
  },
  {
    keys: 'pgup/dn',
    description: 'Page through transcript',
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
  if (!key.ctrl) return undefined

  const letter = input.toLowerCase()
  if (letter === 't') return 'toggle-thinking'
  if (letter === 'y') return 'toggle-permissions'
  if (letter === 'p') return 'open-palette'
  return undefined
}
