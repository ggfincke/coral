// tests/config/inference.test.ts
// user-level inference config: JSON keys with env overrides

import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveInferenceConfig } from '../../src/config/inference.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

async function withHomeAndEnv<T>(
  home: string,
  env: { python?: string; mlxModelsDir?: string },
  fn: () => T | Promise<T>
): Promise<T>
{
  const originalHome = process.env.HOME
  const originalPython = process.env.CORAL_PYTHON
  const originalDir = process.env.CORAL_MLX_MODELS_DIR
  process.env.HOME = home
  if (env.python === undefined) delete process.env.CORAL_PYTHON
  else process.env.CORAL_PYTHON = env.python
  if (env.mlxModelsDir === undefined) delete process.env.CORAL_MLX_MODELS_DIR
  else process.env.CORAL_MLX_MODELS_DIR = env.mlxModelsDir
  try
  {
    return await fn()
  }
  finally
  {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalPython === undefined) delete process.env.CORAL_PYTHON
    else process.env.CORAL_PYTHON = originalPython
    if (originalDir === undefined) delete process.env.CORAL_MLX_MODELS_DIR
    else process.env.CORAL_MLX_MODELS_DIR = originalDir
  }
}

test('resolveInferenceConfig reads ~/.coral.json and lets env win', async () =>
{
  const home = await tempDir('coral-inference-config-')
  await writeFile(
    join(home, '.coral.json'),
    JSON.stringify({
      inference: {
        python: '/json/python',
        mlxModelsDir: '/json/weights',
      },
    }),
    'utf-8'
  )

  await withHomeAndEnv(home, {}, () =>
  {
    assert.deepEqual(resolveInferenceConfig(), {
      python: '/json/python',
      mlxModelsDir: '/json/weights',
    })
  })

  await withHomeAndEnv(
    home,
    { python: '/env/python', mlxModelsDir: '/env/weights' },
    () =>
    {
      assert.deepEqual(resolveInferenceConfig(), {
        python: '/env/python',
        mlxModelsDir: '/env/weights',
      })
    }
  )
})
