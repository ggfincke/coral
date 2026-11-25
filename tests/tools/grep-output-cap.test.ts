// tests/tools/grep-output-cap.test.ts
// grep pages a match stream larger than the old 5 MiB buffer instead of failing

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { grepTool } from '../../src/tools/grep.js'

test('grep over more than 5 MiB of matches returns the first 200 and the total', async () =>
{
  const dir = mkdtempSync(join(tmpdir(), 'coral-grep-cap-'))
  try
  {
    const lineCount = 120_000
    const line = `needle ${'x'.repeat(50)}\n`
    writeFileSync(join(dir, 'big.txt'), line.repeat(lineCount))

    const result = await grepTool.execute(
      { pattern: 'needle' },
      { cwd: dir, allowOutsideWorkspace: false }
    )

    assert.equal(result.error, undefined)
    const lines = result.output.split('\n')
    assert.equal(lines.filter((row) => row.startsWith('big.txt:')).length, 200)
    assert.match(
      result.output,
      new RegExp(`Showing 200 of ${lineCount} matches`)
    )
  }
  finally
  {
    rmSync(dir, { recursive: true, force: true })
  }
})
