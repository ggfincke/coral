// tests/tools/skill-tool.test.ts
// skill tool loads bodies, returns the catalog, and rejects path escape

import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { SkillIndex } from '../../src/skills/types.js'
import { createSkillTool } from '../../src/tools/skill.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

test('skill tool loads a body, lists unknown names, and rejects path escape', async () =>
{
  const root = await tempDir('coral-skill-tool-')
  const packageDir = join(root, 'demo')
  await mkdir(join(packageDir, 'references'), { recursive: true })
  await writeFile(
    join(packageDir, 'SKILL.md'),
    '---\nname: demo\ndescription: Demo skill\n---\n# Demo body\n',
    'utf-8'
  )
  await writeFile(
    join(packageDir, 'references', 'extra.md'),
    '# Extra\n',
    'utf-8'
  )
  await mkdir(join(packageDir, 'scripts'), { recursive: true })
  await writeFile(join(packageDir, 'scripts', 'run.sh'), 'private\n', 'utf-8')
  await writeFile(join(root, 'outside.md'), 'leaked\n', 'utf-8')

  const index = new SkillIndex([
    {
      name: 'demo',
      description: 'Demo skill',
      source: 'user',
      root: packageDir,
    },
  ])
  const tool = createSkillTool(index)

  const loaded = await tool.execute({ name: 'demo' })
  assert.equal(loaded.error, undefined)
  assert.match(loaded.output, /Demo body/)

  const extra = await tool.execute({
    name: 'demo',
    file: 'references/extra.md',
  })
  assert.match(extra.output, /Extra/)

  const script = await tool.execute({
    name: 'demo',
    file: 'scripts/run.sh',
  })
  assert.equal(script.output, '')
  assert.match(script.error ?? '', /SKILL\.md or a file under references/)

  const unknown = await tool.execute({ name: 'missing' })
  assert.equal(unknown.error, undefined)
  assert.match(unknown.output, /Unknown skill/)
  assert.match(unknown.output, /\*\*demo\*\*: Demo skill/)

  const escaped = await tool.execute({ name: 'demo', file: '../outside.md' })
  assert.equal(escaped.output, '')
  assert.match(escaped.error ?? '', /relative path inside the skill package/)
})
