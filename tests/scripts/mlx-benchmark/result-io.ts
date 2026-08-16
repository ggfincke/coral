// tests/scripts/mlx-benchmark/result-io.ts
// atomic result persistence and Draft 2020-12 schema validation

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import type { BenchmarkResult } from './types.js'

// preserve the namespace shape expected by NodeNext for this CJS export
const addFormats =
  addFormatsModule as unknown as typeof addFormatsModule.default

export function saveBenchmarkResult(
  path: string,
  result: BenchmarkResult
): void
{
  saveBenchmarkJson(path, result)
}

export function saveBenchmarkJson(path: string, value: unknown): void
{
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  )
  try
  {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    if (process.platform !== 'win32') chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  }
  finally
  {
    rmSync(temporary, { force: true })
  }
}

export async function loadBenchmarkResult(
  path: string,
  schemaPath: string
): Promise<BenchmarkResult>
{
  const schema: unknown = JSON.parse(await readFile(schemaPath, 'utf8'))
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  const ajv = addFormats(
    new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
  )
  const validate = ajv.compile(schema as Record<string, unknown>)
  if (!validate(value))
  {
    const detail = ajv.errorsText(validate.errors, { separator: '\n' })
    throw new Error(`benchmark result did not match its schema:\n${detail}`)
  }
  return value as BenchmarkResult
}
