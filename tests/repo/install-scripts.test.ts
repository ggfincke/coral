// tests/repo/install-scripts.test.ts
// prove the tracked .npmrc turns an unlisted install script into a failed install

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoNpmrc = fileURLToPath(new URL('../../.npmrc', import.meta.url))

// drop npm_config_* inherited from `npm test` so only the copied .npmrc counts
function npmEnv(): NodeJS.ProcessEnv
{
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toLowerCase().startsWith('npm_config_')
    )
  )
}

function npm(cwd: string, args: string[])
{
  return spawnSync('npm', args, { cwd, env: npmEnv(), encoding: 'utf8' })
}

test('unlisted postinstall fails the install under the repo .npmrc', async (t) =>
{
  const directory = await mkdtemp(join(tmpdir(), 'coral-install-scripts-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const marker = join(directory, 'postinstall-ran')
  const dependency = join(directory, 'unlisted')
  const project = join(directory, 'project')
  await mkdir(dependency)
  await mkdir(project)
  await writeFile(
    join(dependency, 'package.json'),
    JSON.stringify({
      name: 'unlisted-install-script',
      version: '1.0.0',
      scripts: {
        postinstall: `node -e "require('fs').writeFileSync('${marker}', '')"`,
      },
    })
  )
  const packed = npm(dependency, ['pack', '--silent'])
  assert.equal(packed.status, 0, packed.stderr)
  await copyFile(repoNpmrc, join(project, '.npmrc'))
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'install-scripts-probe',
      version: '1.0.0',
      private: true,
      dependencies: {
        'unlisted-install-script': `file:../unlisted/${packed.stdout.trim()}`,
      },
    })
  )
  const install = npm(project, [
    'install',
    '--offline',
    '--no-audit',
    '--no-fund',
  ])
  assert.notEqual(install.status, 0)
  assert.match(install.stderr, /ESTRICTALLOWSCRIPTS/)
  assert.equal(existsSync(marker), false)
})
