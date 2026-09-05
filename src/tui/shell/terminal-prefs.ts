// src/tui/shell/terminal-prefs.ts
// read color/motion/keyboard opt-outs and opt-ins from terminal env

export interface TerminalEnv
{
  readonly [key: string]: string | undefined
}

const TRUTHY_VALUES = new Set(['1', 'true', 'yes'])

// NO_COLOR non-empty OR FORCE_COLOR === '0' disables color output
export function noColorRequested(env?: TerminalEnv): boolean
{
  const source = env ?? process.env
  const noColor = source.NO_COLOR
  if (noColor !== undefined && noColor !== '')
  {
    return true
  }
  return source.FORCE_COLOR === '0'
}

// CORAL_REDUCED_MOTION truthy OR TERM === 'dumb' asks for calmer rendering
export function prefersReducedMotion(env?: TerminalEnv): boolean
{
  const source = env ?? process.env
  const reduced = source.CORAL_REDUCED_MOTION
  if (reduced !== undefined && TRUTHY_VALUES.has(reduced.toLowerCase()))
  {
    return true
  }
  return source.TERM === 'dumb'
}

// explicit opt-in gate for the kitty keyboard protocol; never on by default
export function kittyKeyboardOptIn(env?: TerminalEnv): boolean
{
  const source = env ?? process.env
  return source.CORAL_KITTY_KEYBOARD === '1'
}

// OSC 8 file hyperlinks are strictly opt-in; string-width already treats the
// wrappers as zero-width so wrapping math stays correct when enabled
export function hyperlinksRequested(env?: TerminalEnv): boolean
{
  const source = env ?? process.env
  return source.CORAL_HYPERLINKS === '1'
}
