// tests/tools/path-policy.test.ts
// protected-path classification for file-tool writes

import { strict as assert } from 'node:assert'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { touchesProtectedPath } from '../../src/tools/path-policy.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDirSync } = makeTempDirPool()
const restoreCoralHome = captureCoralHome()

after(() => restoreCoralHome())

test('git internals, Coral homes, and ~/.coral.json are protected from file writes', async () =>
{
  // the workspace is the isolated test HOME, so every control file is inside
  const home = homedir()
  const coralHome = join(home, '.coral')
  delete process.env.CORAL_HOME
  mkdirSync(join(home, '.git'), { recursive: true })
  writeFileSync(join(home, '.git', 'config'), '[core]\n')
  mkdirSync(join(coralHome, 'tool-grants.d'), { recursive: true })
  symlinkSync(join(home, '.git', 'config'), join(home, 'innocent.txt'))

  const writes = (path: string) =>
    touchesProtectedPath('write_file', { path, content: '' }, home)

  assert.equal(await writes('.git/config'), true)
  assert.equal(await writes('.GIT/hooks/pre-commit'), true)
  assert.equal(await writes('innocent.txt'), true)
  assert.equal(await writes('.coral/tool-grants.d/x.json'), true)
  assert.equal(await writes('.agents/AGENTS.md'), true)
  assert.equal(await writes('.coral.json'), true)
  assert.equal(await writes('notes/todo.md'), false)
  // reads and non-file tools are not classified
  assert.equal(
    await touchesProtectedPath('read_file', { path: '.git/config' }, home),
    false
  )

  // a jobs worktree nested in CORAL_HOME keeps its own files writable, while
  // the rest of CORAL_HOME stays protected
  const worktree = join(coralHome, 'jobs', 'job-1', 'worktree')
  mkdirSync(worktree, { recursive: true })
  assert.equal(
    await touchesProtectedPath('edit_file', { path: 'src/a.ts' }, worktree),
    false
  )
  assert.equal(
    await touchesProtectedPath(
      'edit_file',
      { path: join(coralHome, 'tool-grants.d', 'x.json') },
      worktree
    ),
    true
  )

  // any other workspace nested in CORAL_HOME gets no carve-out
  assert.equal(
    await touchesProtectedPath(
      'write_file',
      { path: 'x.json', content: '' },
      join(coralHome, 'tool-grants.d')
    ),
    true
  )

  // a CORAL_HOME override moves the protected root with it
  const override = tempDirSync('coral-policy-home-')
  process.env.CORAL_HOME = override
  assert.equal(await writes(join(override, 'mcp-trust.d', 'x.json')), true)
})

test('case variants of missing protected roots match on case-insensitive platforms', async (t) =>
{
  const home = tempDirSync('coral-policy-case-')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  t.after(() => Object.defineProperty(process, 'platform', platform))
  process.env.CORAL_HOME = join(home, '.coral')
  const previousAgentsHome = process.env.AGENTS_HOME
  process.env.AGENTS_HOME = join(home, '.agents')
  t.after(() =>
  {
    if (previousAgentsHome === undefined) delete process.env.AGENTS_HOME
    else process.env.AGENTS_HOME = previousAgentsHome
  })
  const userConfig = join(homedir(), '.Coral.json')
  const writes = (path: string) =>
    touchesProtectedPath('write_file', { path, content: '' }, home)

  // none of these roots exist yet, so only a case fold can match them
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  assert.equal(await writes(userConfig), true)
  assert.equal(await writes(join(home, '.Agents', 'AGENTS.md')), true)
  assert.equal(await writes(join(home, '.CORAL', 'mcp-trust.d', 'x')), true)
  Object.defineProperty(process, 'platform', { value: 'win32' })
  assert.equal(await writes(userConfig), true)

  // linux volumes are case-sensitive, so the variant is a different file
  Object.defineProperty(process, 'platform', { value: 'linux' })
  assert.equal(await writes(userConfig), false)
  assert.equal(await writes(join(home, '.Agents', 'AGENTS.md')), false)
})
