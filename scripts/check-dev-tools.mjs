// scripts/check-dev-tools.mjs
// run dev-tool syntax, tests, & runtime drift checks

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const errors = []

function run(command, args)
{
  execFileSync(command, args, { stdio: 'inherit' })
}

function read(path)
{
  return readFileSync(path, 'utf8')
}

function requireMatch(text, pattern, label)
{
  const match = text.match(pattern)
  if (!match)
  {
    errors.push(`Could not find ${label}.`)
    return undefined
  }
  return match
}

function extractNumber(text, pattern, label)
{
  const match = requireMatch(text, pattern, label)
  return match ? Number(match[1]) : undefined
}

function extractPythonStringSet(text, name)
{
  const match = requireMatch(
    text,
    new RegExp(`${name} = \\{([\\s\\S]*?)\\n\\}`),
    name
  )
  if (!match) return []

  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort()
}

function extractPythonString(text, name)
{
  const match = requireMatch(
    text,
    new RegExp(`^${name} = "([^"]+)"$`, 'm'),
    name
  )
  return match?.[1]
}

function loadRuntimeToolDefaults()
{
  const source = `
    import {
      builtInToolRegistrations,
      UNKNOWN_TOOL_DEFAULT_POLICY,
    } from './src/tools/catalog.ts'
    process.stdout.write(JSON.stringify({
      registrations: builtInToolRegistrations,
      unknownPolicy: UNKNOWN_TOOL_DEFAULT_POLICY,
    }))
  `
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    { encoding: 'utf8' }
  )
  return JSON.parse(output)
}

function compare(label, left, right)
{
  if (left !== right)
  {
    errors.push(`${label} drifted: analyzer=${left} runtime=${right}.`)
  }
}

function compareLists(label, left, right)
{
  if (left.join('\n') !== right.join('\n'))
  {
    errors.push(
      `${label} drifted:\n` +
        `  analyzer=${left.join(', ')}\n` +
        `  runtime=${right.join(', ')}`
    )
  }
}

function checkRuntimeDrift()
{
  const analyzer = read('scripts/lib/coral_dev_tools/session_analysis.py')
  const limits = read('src/utils/limits.ts')
  const toolDefaults = loadRuntimeToolDefaults()

  compare(
    'CHARS_PER_TOKEN',
    extractNumber(analyzer, /^CHARS_PER_TOKEN = (\d+)$/m, 'CHARS_PER_TOKEN'),
    extractNumber(
      limits,
      /^export const CHARS_PER_TOKEN = (\d+)$/m,
      'runtime CHARS_PER_TOKEN'
    )
  )
  compareLists(
    'default always-allowed tool policy',
    extractPythonStringSet(analyzer, 'DEFAULT_ALWAYS_ALLOWED_TOOLS'),
    toolDefaults.registrations
      .filter((registration) => registration.defaultPolicy === 'always_allow')
      .map((registration) => registration.name)
      .sort()
  )
  compareLists(
    'default-gated built-in tool policy',
    extractPythonStringSet(analyzer, 'DEFAULT_GATED_BUILT_IN_TOOLS'),
    toolDefaults.registrations
      .filter((registration) => registration.defaultPolicy !== 'always_allow')
      .map((registration) => registration.name)
      .sort()
  )
  compare(
    'unknown tool default policy',
    extractPythonString(analyzer, 'DEFAULT_UNKNOWN_TOOL_POLICY'),
    toolDefaults.unknownPolicy
  )
}

run('uv', [
  'run',
  'python',
  '-m',
  'compileall',
  '-q',
  'scripts',
  'tests/scripts',
])
run('uv', ['run', 'python', '-m', 'unittest', 'discover', 'tests/scripts'])
checkRuntimeDrift()

if (errors.length > 0)
{
  console.error('\nDev-tool check failed:\n')
  for (const error of errors)
  {
    console.error(`- ${error}`)
  }
  console.error('')
  process.exit(1)
}

console.log('Dev-tool checks passed')
