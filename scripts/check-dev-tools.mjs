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

function extractTsRequireApprovalTools(text)
{
  const match = requireMatch(
    text,
    /const DEFAULT_TOOL_POLICIES: ToolPermissions = \{([\s\S]*?)\n\}/,
    'DEFAULT_TOOL_POLICIES'
  )
  if (!match) return []

  const tools = []
  for (const item of match[1].matchAll(/^\s*([A-Za-z0-9_]+): '([^']+)'/gm))
  {
    if (item[2] === 'require_approval')
    {
      tools.push(item[1])
    }
  }
  return tools.sort()
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
  const sessionStore = read('src/session/store.ts')
  const permissions = read('src/config/permissions.ts')

  compare(
    'CHARS_PER_TOKEN',
    extractNumber(analyzer, /^CHARS_PER_TOKEN = (\d+)$/m, 'CHARS_PER_TOKEN'),
    extractNumber(
      limits,
      /^export const CHARS_PER_TOKEN = (\d+)$/m,
      'runtime CHARS_PER_TOKEN'
    )
  )
  compare(
    'SESSION_INDEX_VERSION',
    extractNumber(
      analyzer,
      /^SESSION_INDEX_VERSION = (\d+)$/m,
      'SESSION_INDEX_VERSION'
    ),
    extractNumber(
      sessionStore,
      /^const SESSION_INDEX_VERSION = (\d+)$/m,
      'runtime SESSION_INDEX_VERSION'
    )
  )
  compareLists(
    'require-approval tool policy',
    extractPythonStringSet(analyzer, 'DEFAULT_APPROVAL_GATED_TOOLS'),
    extractTsRequireApprovalTools(permissions)
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
