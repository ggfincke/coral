// tests/scripts/eval/grade.ts
// deterministic grader helpers used by eval tasks

import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import type { GradeResult } from './types.js'

// default text extensions walked by treeContains/treeFreeOf
const DEFAULT_TEXT_EXTS = ['.js', '.mjs', '.ts', '.json', '.txt']

// dirs never descended into during a tree walk
const SKIP_DIRS = new Set(['node_modules', '.git'])

// read a file under dir; null when missing
export async function readFileSafe(
  dir: string,
  rel: string
): Promise<string | null>
{
  try
  {
    return await readFile(join(dir, rel), 'utf-8')
  }
  catch
  {
    return null
  }
}

// read & parse JSON under dir; null when missing or invalid
export async function readJson(
  dir: string,
  rel: string
): Promise<unknown | null>
{
  const text = await readFileSafe(dir, rel)
  if (text === null) return null
  try
  {
    return JSON.parse(text)
  }
  catch
  {
    return null
  }
}

// case-insensitive substring match against the agent's final answer
export function answerContains(finalText: string, needle: string): boolean
{
  return finalText.toLowerCase().includes(needle.toLowerCase())
}

// run node in dir; exit code or 1 when it died w/o one. drop an inherited
// NODE_TEST_CONTEXT so a nested node --test prints TAP, not the parent's protocol
export function runNode(
  dir: string,
  args: string[],
  timeoutMs?: number
): Promise<{ code: number; stdout: string; stderr: string }>
{
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return new Promise((resolve) =>
  {
    execFile(
      'node',
      args,
      { cwd: dir, timeout: timeoutMs, env, encoding: 'utf-8' },
      (err, stdout, stderr) =>
      {
        const code =
          err === null ? 0 : typeof err.code === 'number' ? err.code : 1
        resolve({ code, stdout, stderr })
      }
    )
  })
}

// escape a test name the way the TAP reporter does, then for a RegExp
function tapNamePattern(name: string): string
{
  const tap = name.replace(/\\/g, '\\\\').replace(/#/g, '\\#')
  return tap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// run node --test w/ the TAP reporter & require each named test to report ok;
// exit 0 alone is not enough since a source that exits early also exits 0
export async function runLockedTests(
  dir: string,
  testPaths: string[],
  testNames: string[],
  timeoutMs?: number
): Promise<GradeResult>
{
  if (testNames.length === 0)
  {
    throw new Error('runLockedTests needs at least one expected test name')
  }
  const { code, stdout } = await runNode(
    dir,
    ['--test', '--test-reporter=tap', ...testPaths],
    timeoutMs
  )
  if (code !== 0)
  {
    return { passed: false, detail: `node --test exited ${code}` }
  }
  const missing = testNames.filter(
    (name) =>
      !new RegExp(`^\\s*ok \\d+ - ${tapNamePattern(name)}$`, 'm').test(stdout)
  )
  if (missing.length > 0)
  {
    return {
      passed: false,
      detail: `node --test exited 0 but did not pass: ${missing.join(', ')}`,
    }
  }
  return { passed: true, detail: 'node --test passed' }
}

// recursively collect text-file paths under dir, skipping node_modules/.git
async function collectTextFiles(
  dir: string,
  exts: string[]
): Promise<string[]>
{
  const found: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries)
  {
    const full = join(dir, entry.name)
    if (entry.isDirectory())
    {
      if (SKIP_DIRS.has(entry.name)) continue
      found.push(...(await collectTextFiles(full, exts)))
    }
    else if (entry.isFile() && exts.includes(extname(entry.name)))
    {
      found.push(full)
    }
  }

  return found
}

// true when pattern matches the contents of any walked text file
export async function treeContains(
  dir: string,
  pattern: RegExp,
  includeExt?: string[]
): Promise<boolean>
{
  const exts = includeExt ?? DEFAULT_TEXT_EXTS
  const files = await collectTextFiles(dir, exts)

  for (const file of files)
  {
    const text = await readFile(file, 'utf-8')
    if (pattern.test(text)) return true
  }

  return false
}

// true when pattern matches nowhere across the walked text files
export async function treeFreeOf(
  dir: string,
  pattern: RegExp,
  includeExt?: string[]
): Promise<boolean>
{
  return !(await treeContains(dir, pattern, includeExt))
}
