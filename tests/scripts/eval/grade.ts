// tests/scripts/eval/grade.ts
// deterministic grader helpers used by eval tasks

import { readFile, readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { execFileCommand } from '../../../src/utils/process.js'

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

// run node in dir; reuse execFileCommand, map ok->0 else numeric code or 1
export async function runNode(
  dir: string,
  args: string[],
  timeoutMs?: number
): Promise<{ code: number; stdout: string; stderr: string }>
{
  const result = await execFileCommand('node', args, {
    cwd: dir,
    timeout: timeoutMs,
  })

  if (result.ok)
  {
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  }

  const code = typeof result.code === 'number' ? result.code : 1
  return { code, stdout: result.stdout, stderr: result.stderr }
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
