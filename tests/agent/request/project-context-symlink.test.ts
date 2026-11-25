// tests/agent/request/project-context-symlink.test.ts
// project instruction files stay confined to the workspace

import { strict as assert } from 'node:assert'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  captureProjectContext,
  gatherProjectContext,
} from '../../../src/agent/request/project-context.js'
import { makeTempDirPool } from '../../helpers/temp.js'

const { tempDir } = makeTempDirPool()

test('instruction-file links load only when they resolve inside the workspace', async () =>
{
  const escaping = await tempDir('coral-ctx-escape-')
  const outside = await tempDir('coral-ctx-outside-')
  await writeFile(join(outside, 'private.txt'), 'outside-secret\n')
  await symlink(join(outside, 'private.txt'), join(escaping, 'AGENTS.md'))
  assert.doesNotMatch(
    gatherProjectContext(escaping),
    /outside-secret|links outside/
  )
  assert.deepEqual(captureProjectContext(escaping).notices, [
    'AGENTS.md links outside the workspace; not loaded',
  ])

  const inside = await tempDir('coral-ctx-inside-')
  await mkdir(join(inside, 'docs'))
  await writeFile(join(inside, 'docs', 'agents.md'), 'inside-instructions\n')
  await symlink(join(inside, 'docs', 'agents.md'), join(inside, 'AGENTS.md'))
  assert.match(gatherProjectContext(inside), /inside-instructions/)
})
