// tests/scripts/eval/tasks.ts
// the 6-task eval suite: fixtures, prompts, & deterministic graders

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EvalTask } from './types.js'
import {
  answerContains,
  readFileSafe,
  readJson,
  runNode,
  treeContains,
  treeFreeOf,
} from './grade.js'

// bound for grader-spawned node so a wedged child can't hang the suite
const GRADE_TIMEOUT_MS = 30000

// expected fizzbuzz output for 1..15, one token per line
const FIZZBUZZ_EXPECTED = [
  '1',
  '2',
  'Fizz',
  '4',
  'Buzz',
  'Fizz',
  '7',
  '8',
  'Fizz',
  'Buzz',
  '11',
  'Fizz',
  '13',
  '14',
  'FizzBuzz',
]

// narrow an unknown record's string field w/o trusting its shape
function stringField(value: unknown, key: string): string | null
{
  if (typeof value !== 'object' || value === null) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : null
}

// 1) read a config value out of a json file & answer in chat
const readReport: EvalTask = {
  id: 'read-report',
  description: 'read a config value & report it in the final answer',
  prompt: 'What port is configured in config.json?',
  async setup(dir)
  {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ service: 'coral', port: 8137, debug: false }, null, 2) +
        '\n'
    )
    // distractor — a different number that must not be confused for the port
    await writeFile(
      join(dir, 'notes.txt'),
      'remember to renew the cert before 2099 & ping ops on channel 4242\n'
    )
  },
  async grade(ctx)
  {
    const found = answerContains(ctx.finalText, '8137')
    return {
      passed: found,
      detail: found ? 'answer has 8137' : 'expected 8137, answer had no match',
    }
  },
}

// 2) bump a single field in package.json via an edit
const singleEdit: EvalTask = {
  id: 'single-edit',
  description: 'bump the version field in package.json',
  prompt: 'Bump the version in package.json to 2.4.0.',
  async setup(dir)
  {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'widget', version: '1.0.0' }, null, 2) + '\n'
    )
  },
  async grade(ctx)
  {
    const pkg = await readJson(ctx.dir, 'package.json')
    if (pkg === null)
    {
      return { passed: false, detail: 'package.json missing or invalid json' }
    }
    const name = stringField(pkg, 'name')
    const version = stringField(pkg, 'version')
    const passed = name === 'widget' && version === '2.4.0'
    return {
      passed,
      detail: passed
        ? 'name preserved, version is 2.4.0'
        : `expected widget@2.4.0, got ${name ?? 'absent'}@${version ?? 'absent'}`,
    }
  },
}

// 3) create a file w/ exact contents
const createFile: EvalTask = {
  id: 'create-file',
  description: 'create greeting.txt w/ exact contents',
  prompt:
    'Create a file named greeting.txt whose entire contents are exactly: hello world',
  async setup()
  {
    // no fixtures — the agent creates the file from scratch
  },
  async grade(ctx)
  {
    const text = await readFileSafe(ctx.dir, 'greeting.txt')
    if (text === null)
    {
      return { passed: false, detail: 'greeting.txt missing' }
    }
    const passed = text === 'hello world'
    return {
      passed,
      detail: passed
        ? 'greeting.txt is "hello world"'
        : `expected "hello world", got ${JSON.stringify(text)}`,
    }
  },
}

// 4) rename a function across definition & call sites
const searchMultiEdit: EvalTask = {
  id: 'search-multi-edit',
  description: 'rename oldName -> newName across the project',
  prompt:
    'Rename the function oldName to newName everywhere in this project, including its call sites.',
  async setup(dir)
  {
    await writeFile(
      join(dir, 'a.mjs'),
      [
        'export function oldName()',
        '{',
        "  return 'a'",
        '}',
        '',
        'export const aResult = oldName()',
        '',
      ].join('\n')
    )
    await writeFile(
      join(dir, 'b.mjs'),
      [
        "import { oldName } from './a.mjs'",
        '',
        'export const bResult = oldName()',
        '',
      ].join('\n')
    )
  },
  async grade(ctx)
  {
    const hasNew = await treeContains(ctx.dir, /\bnewName\b/)
    const freeOfOld = await treeFreeOf(ctx.dir, /\boldName\b/)
    const passed = hasNew && freeOfOld
    let detail: string
    if (passed)
    {
      detail = 'newName present, oldName gone'
    }
    else if (!hasNew)
    {
      detail = 'newName not found in tree'
    }
    else
    {
      detail = 'oldName still present in tree'
    }
    if (!passed)
    {
      return { passed, detail }
    }
    const { code } = await runNode(
      ctx.dir,
      [
        '--input-type=module',
        '-e',
        "const b = await import('./b.mjs'); if (b.bResult !== 'a') process.exit(1)",
      ],
      GRADE_TIMEOUT_MS
    )
    if (code !== 0)
    {
      return { passed: false, detail: 'renamed modules do not execute' }
    }
    return { passed, detail }
  },
}

// 5) write fizzbuzz then verify by re-running node ourselves
const buildRun: EvalTask = {
  id: 'build-run',
  description: 'create fizzbuzz.mjs & verify its output by execution',
  prompt:
    'Create fizzbuzz.mjs that prints the numbers 1 through 15 one per line, but prints Fizz for multiples of 3, Buzz for multiples of 5, and FizzBuzz for multiples of both. Then run it to confirm.',
  async setup()
  {
    // no fixtures — the agent creates fizzbuzz.mjs
  },
  async grade(ctx)
  {
    // never trust the model's claim — re-run node & check stdout
    const { code, stdout } = await runNode(
      ctx.dir,
      ['fizzbuzz.mjs'],
      GRADE_TIMEOUT_MS
    )
    if (code !== 0)
    {
      return { passed: false, detail: `fizzbuzz.mjs exited ${code}` }
    }
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const passed =
      lines.length === FIZZBUZZ_EXPECTED.length &&
      lines.every((line, i) => line === FIZZBUZZ_EXPECTED[i])
    return {
      passed,
      detail: passed
        ? 'fizzbuzz output matches 1..15'
        : `output mismatch: got ${lines.length} lines`,
    }
  },
}

// exact seeded test fixture — locked so a model can't pass by weakening it
const SUM_TEST_FIXTURE = [
  "import assert from 'node:assert'",
  "import test from 'node:test'",
  "import { sum } from './sum.mjs'",
  '',
  "test('sum adds its arguments', () =>",
  '{',
  '  assert.strictEqual(sum(2, 3), 5)',
  '  assert.strictEqual(sum(10, 5), 15)',
  '})',
  '',
].join('\n')

// 6) fix a bug so the test passes then verify by re-running the test
const bugFixVerify: EvalTask = {
  id: 'bug-fix-verify',
  description: 'fix the sum bug & verify via node --test',
  prompt:
    'The test in sum.test.mjs is failing. Fix the bug in sum.mjs so the test passes, then run the test to confirm.',
  async setup(dir)
  {
    // bug: subtracts instead of adds
    await writeFile(
      join(dir, 'sum.mjs'),
      'export function sum(a, b)\n{\n  return a - b\n}\n'
    )
    await writeFile(join(dir, 'sum.test.mjs'), SUM_TEST_FIXTURE)
  },
  async grade(ctx)
  {
    // reject editing the test instead of the source — fixture must be untouched
    const testFile = await readFileSafe(ctx.dir, 'sum.test.mjs')
    if (testFile !== SUM_TEST_FIXTURE)
    {
      return { passed: false, detail: 'sum.test.mjs was modified, not sum.mjs' }
    }
    // the source must still define sum & now add rather than subtract
    const source = await readFileSafe(ctx.dir, 'sum.mjs')
    if (source === null || !/function\s+sum\b/.test(source))
    {
      return {
        passed: false,
        detail: 'sum.mjs missing or no longer defines sum',
      }
    }
    // re-run the locked test ourselves — exit 0 only when the fix is real
    const { code } = await runNode(
      ctx.dir,
      ['--test', 'sum.test.mjs'],
      GRADE_TIMEOUT_MS
    )
    const passed = code === 0
    return {
      passed,
      detail: passed ? 'node --test passed' : `node --test exited ${code}`,
    }
  },
}

export const TASKS: EvalTask[] = [
  readReport,
  singleEdit,
  createFile,
  searchMultiEdit,
  buildRun,
  bugFixVerify,
]

export function taskById(id: string): EvalTask | undefined
{
  return TASKS.find((task) => task.id === id)
}
