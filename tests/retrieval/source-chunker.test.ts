// tests/retrieval/source-chunker.test.ts
// tests for source-preserving syntax-aware retrieval chunks

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { chunkText } from '../../src/retrieval/chunker.js'
import { chunkSource } from '../../src/retrieval/source-chunker.js'
import { CHUNKER_VERSION, type CodeChunk } from '../../src/retrieval/types.js'

function assertSourceCoverage(content: string, chunks: CodeChunk[]): void
{
  const lines = content.split(/\r?\n/)
  const covered = new Set<number>()
  for (const [index, chunk] of chunks.entries())
  {
    assert.equal(chunk.chunkIndex, index)
    assert.equal(chunk.chunkerVersion, CHUNKER_VERSION)
    assert.ok(chunk.startLine >= 1 && chunk.endLine <= lines.length)
    assert.ok(chunk.startLine <= chunk.endLine)
    assert.ok(chunk.endLine - chunk.startLine < 80)
    const slice = lines.slice(chunk.startLine - 1, chunk.endLine)
    assert.equal(chunk.text, slice.join('\n').trim())
    assert.ok(slice.length === 1 || slice.join('\n').length < 6_000)
    for (let line = chunk.startLine; line <= chunk.endLine; line++)
    {
      covered.add(line)
    }
  }
  for (const [index, line] of lines.entries())
  {
    if (line.trim()) assert.ok(covered.has(index + 1), `lost line ${index + 1}`)
  }
}

function assertWhole(
  content: string,
  chunks: CodeChunk[],
  start: string,
  end: string
): void
{
  const lines = content.split(/\r?\n/)
  const startLine = lines.indexOf(start) + 1
  const endLine = lines.indexOf(end) + 1
  assert.ok(startLine > 0 && endLine >= startLine)
  assert.ok(
    chunks.some(
      (chunk) => chunk.startLine <= startLine && chunk.endLine >= endLine
    ),
    `split ${start}`
  )
}

test('chunkSource packs declarations with comments and preserves source lines', async () =>
{
  for (const extension of ['ts', 'tsx'])
  {
    const declaration =
      extension === 'tsx'
        ? [
            '// render the complete panel',
            'export function Panel() {',
            '  return <section>',
            ...Array.from({ length: 24 }, (_, i) => `    <span>{${i}}</span>`),
            '  </section>',
            '}',
          ]
        : [
            '// collect the complete result',
            'export function collect() {',
            ...Array.from({ length: 24 }, (_, i) => `  const item${i} = ${i}`),
            '  return item23',
            '}',
          ]
    const content = [
      ...Array.from({ length: 65 }, (_, i) => `export const value${i} = ${i}`),
      ...declaration,
      'const left = 1; const right = 2;',
      '// keep this small class intact',
      'export class Pair {',
      '  sum() { return left + right }',
      '};',
      '// retain trailing comments',
      '',
    ].join('\r\n')
    const chunks = await chunkSource(content, `example.${extension}`)
    assertSourceCoverage(content, chunks)
    assertWhole(content, chunks, declaration[0], '}')
    assertWhole(content, chunks, '// keep this small class intact', '};')
    assert.ok(
      chunks.some((chunk) =>
        chunk.text.includes('const left = 1; const right = 2;')
      )
    )
    assert.ok(chunks.length < 10)
    assert.deepEqual(await chunkSource(content, `example.${extension}`), chunks)
  }

  const wide = [
    `const heading = '${'h'.repeat(5_000)}'`,
    '// a fitting function following a wide declaration',
    'export function wide() {',
    `  return '${'w'.repeat(1_100)}'`,
    '}',
  ].join('\n')
  const chunks = await chunkSource(wide, 'wide.ts')
  assertSourceCoverage(wide, chunks)
  assert.equal(chunks.length, 2)
  assertWhole(
    wide,
    chunks,
    '// a fitting function following a wide declaration',
    '}'
  )

  // a leading comment must not split a class that exactly fills the line budget
  const full = [
    '// keep this comment even when it cannot fit beside the class',
    'export class Full {',
    ...Array.from({ length: 78 }, (_, i) => `  value${i} = ${i}`),
    '}',
  ].join('\n')
  const fullChunks = await chunkSource(full, 'full.ts')
  assertSourceCoverage(full, fullChunks)
  assertWhole(full, fullChunks, 'export class Full {', '}')
})

test('chunkSource splits oversized classes at members and overlaps only oversized members', async () =>
{
  const method = (name: string, count: number) => [
    `  // ${name} stays attached`,
    `  ${name}() {`,
    ...Array.from({ length: count }, (_, i) => `    const ${name}${i} = ${i}`),
    `    return ${name}${count - 1}`,
    '  }',
  ]
  const content = [
    '// preserve the class header',
    '@sealed',
    'export class Example {',
    ...method('first', 30),
    ...method('second', 30),
    ...method('large', 170),
    ...method('last', 30),
    '}',
    '// preserve the class footer',
  ].join('\n')
  const chunks = await chunkSource(content, 'example.ts')
  assertSourceCoverage(content, chunks)
  for (const name of ['first', 'second', 'last'])
  {
    assert.ok(
      chunks.some((chunk) =>
        chunk.text.includes(method(name, 30).join('\n').trim())
      )
    )
  }
  assertWhole(
    content,
    chunks,
    '// preserve the class header',
    'export class Example {'
  )
  const lines = content.split('\n')
  const largeStart = lines.indexOf('  // large stays attached') + 1
  const largeEnd = lines.indexOf('    return large169') + 2
  const overlaps = chunks
    .slice(1)
    .filter((chunk, i) => chunk.startLine <= chunks[i].endLine)
  assert.ok(overlaps.length > 0)
  for (const chunk of overlaps)
  {
    const previous = chunks[chunk.chunkIndex - 1]
    assert.equal(previous.endLine - chunk.startLine + 1, 10)
    assert.ok(chunk.startLine >= largeStart && chunk.endLine <= largeEnd)
  }
})

test('chunkSource preserves incomplete syntax and the existing line fallback', async () =>
{
  const incomplete = [
    '// a class being edited',
    'export class Partial {',
    '  complete() { return 1 }',
    '  unfinished() {',
    ...Array.from({ length: 90 }, (_, i) => `    const value${i} = ${i}`),
    '    return (',
  ].join('\n')
  assertSourceCoverage(incomplete, await chunkSource(incomplete, 'partial.ts'))

  const plain = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
  for (const path of [undefined, 'notes.md'])
  {
    assert.deepEqual(await chunkSource(plain, path), chunkText(plain))
  }

  const longLine = `export const long = '${'x'.repeat(7_000)}'`
  const source = `${longLine}\nexport const after = 1\n`
  const chunks = await chunkSource(source, 'long.ts')
  assertSourceCoverage(source, chunks)
  assert.equal(chunks[0].text, longLine)
  assert.equal(chunks[0].startLine, chunks[0].endLine)
  assert.equal(chunks[1].text, 'export const after = 1')
})
