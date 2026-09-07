// tests/tui/theme-roles.test.ts
// every built-in theme defines the four background roles & they resolve at runtime

import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { THEMES, findTheme, DEFAULT_THEME } from '../../src/tui/themes.js'
import { setTheme, getTheme, style, type Role } from '../../src/tui/theme.js'

const BG_ROLES: readonly Role[] = [
  'diffAddBg',
  'diffRemoveBg',
  'gutter',
  'selection',
]

describe('theme background roles', () =>
{
  it('every built-in theme defines all four background roles', () =>
  {
    for (const theme of THEMES)
    {
      for (const role of BG_ROLES)
      {
        assert.notEqual(
          theme.roles[role],
          undefined,
          `${theme.name} is missing ${role}`
        )
      }
    }
  })

  it('diffAddBg differs between the dark default and a pale theme', () =>
  {
    const dark = DEFAULT_THEME.roles.diffAddBg
    const pale = findTheme('tide-pool')!.roles.diffAddBg
    assert.notDeepEqual(dark, pale)
  })

  it('style() resolves the new roles under multiple active themes', () =>
  {
    const previous = getTheme()
    try
    {
      for (const name of ['coral-reef', 'adaptive'])
      {
        const theme = findTheme(name)
        assert.ok(theme, `built-in theme ${name} not found`)
        setTheme(theme)
        for (const role of BG_ROLES)
        {
          assert.ok(style(role), `style('${role}') failed under ${name}`)
          assert.equal(typeof style(role).bold, 'function')
        }
      }
    }
    finally
    {
      setTheme(previous)
    }
  })
})
