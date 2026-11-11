// tests/helpers/isolate-home.ts
// preload that points each test process at an empty home & a fixed git identity

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// a developer's ~/.coral.json, ~/.agents & global git hooks must not reach tests
const home = mkdtempSync(join(tmpdir(), 'coral-test-home-'))
const gitConfig = join(home, '.gitconfig')
mkdirSync(join(home, '.config'))
writeFileSync(
  gitConfig,
  '[user]\n\tname = Coral Test\n\temail = test@coral.dev\n'
)

process.env.HOME = home
process.env.USERPROFILE = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
process.env.GIT_CONFIG_GLOBAL = gitConfig
process.env.GIT_CONFIG_NOSYSTEM = '1'

process.on('exit', () => rmSync(home, { recursive: true, force: true }))
