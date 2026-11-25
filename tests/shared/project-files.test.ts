// tests/shared/project-files.test.ts
// git-aware project file discovery tests

import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectProjectFiles } from '../../src/shared/project-files.js'
import { HAS_GIT, initTestRepo } from '../helpers/git.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

test(
  'tracked files under a noisy directory name stay listed, untracked ones do not',
  { skip: !HAS_GIT },
  async () =>
  {
    const dir = await tempDir('coral-project-files-')
    const git = initTestRepo(dir)
    await mkdir(join(dir, 'src', 'build'), { recursive: true })
    await writeFile(join(dir, 'src', 'build', 'a.ts'), 'export const a = 1\n')
    assert.equal(git('add', '.').status, 0)
    await writeFile(join(dir, 'src', 'build', 'b.ts'), 'export const b = 1\n')

    const paths = (await collectProjectFiles(dir)).map((file) => file.path)
    assert.deepEqual(paths, ['src/build/a.ts'])
  }
)
