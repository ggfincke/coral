// tests/project-tree.test.ts
// shared project path policy tests

import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  formatProjectDirectoryPath,
  formatProjectPath,
  isPathInsideProject,
} from '../src/shared/project-tree.js'

test('project paths are relative only when inside the cwd boundary', () =>
{
  const cwd = join(tmpdir(), 'coral-path-root')
  const file = join(cwd, 'src', 'index.ts')
  const dotPrefixed = join(cwd, '..cache', 'state.json')
  const sibling = `${cwd}-sibling/src/index.ts`

  assert.equal(isPathInsideProject(cwd, file), true)
  assert.equal(formatProjectPath(cwd, file), 'src/index.ts')
  assert.equal(formatProjectDirectoryPath(cwd, cwd), './')
  assert.equal(isPathInsideProject(cwd, dotPrefixed), true)
  assert.equal(formatProjectPath(cwd, dotPrefixed), '..cache/state.json')
  assert.equal(isPathInsideProject(cwd, sibling), false)
  assert.equal(formatProjectPath(cwd, sibling), sibling)
})
