// scripts/check-packed-cli.mjs
// smoke-test the published CLI from its actual npm archive

import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(
  readFileSync(join(repoRoot, 'package.json'), 'utf8')
)
const tempRoot = mkdtempSync(join(tmpdir(), 'coral-packed-cli-'))

function run(command, args, options = {})
{
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  })
  if (result.status !== 0)
  {
    process.stderr.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    throw new Error(`${command} exited with ${String(result.status)}`)
  }
  return result.stdout
}

try
{
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packed = JSON.parse(
    run(
      npm,
      ['pack', '--ignore-scripts', '--json', '--pack-destination', tempRoot],
      {
        env: {
          ...process.env,
          npm_config_cache: join(tempRoot, 'npm-cache'),
        },
      }
    )
  )
  const packEntries = Array.isArray(packed) ? packed : Object.values(packed)
  const filename = packEntries.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.filename === 'string'
  )?.filename
  if (typeof filename !== 'string' || !filename)
  {
    throw new Error('npm pack did not report an archive filename')
  }

  const sandbox = join(tempRoot, 'sandbox')
  mkdirSync(sandbox)
  run('tar', ['-xzf', join(tempRoot, filename), '-C', sandbox])
  symlinkSync(
    join(repoRoot, 'node_modules'),
    join(sandbox, 'node_modules'),
    'dir'
  )

  const output = run(
    process.execPath,
    [join(sandbox, 'package', 'dist', 'cli', 'main.js'), '--version'],
    { cwd: sandbox }
  ).trim()
  if (output !== packageJson.version)
  {
    throw new Error(
      `packed CLI version mismatch: expected ${packageJson.version}, got ${output}`
    )
  }
  process.stdout.write(`packed CLI smoke passed (${output})\n`)
}
finally
{
  rmSync(tempRoot, { recursive: true, force: true })
}
