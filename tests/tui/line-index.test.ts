// tests/tui/line-index.test.ts
// tests for multi-line prompt cursor mapping & vertical movement

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildLineStarts,
  locateOffset,
  offsetAt,
  verticalMove,
} from '../../src/tui/prompt/line-index.js'

test('buildLineStarts marks every newline boundary', () =>
{
  assert.deepEqual(buildLineStarts(''), [0])
  assert.deepEqual(buildLineStarts('one'), [0])
  assert.deepEqual(buildLineStarts('one\ntwo\nthree'), [0, 4, 8])
  assert.deepEqual(buildLineStarts('a\n'), [0, 2])
})

test('locateOffset & offsetAt round-trip through rows', () =>
{
  const value = 'alpha\nbeta\ngamma'
  const starts = buildLineStarts(value)

  assert.deepEqual(locateOffset(starts, 0), { row: 0, col: 0 })
  assert.deepEqual(locateOffset(starts, 3), { row: 0, col: 3 })
  assert.deepEqual(locateOffset(starts, 6), { row: 1, col: 0 })
  assert.deepEqual(locateOffset(starts, 8), { row: 1, col: 2 })
  assert.deepEqual(locateOffset(starts, 16), { row: 2, col: 5 })

  for (const offset of [0, 3, 5, 6, 10, 11, 16])
  {
    const position = locateOffset(starts, offset)
    assert.equal(offsetAt(value, starts, position), offset)
  }
})

test('offsetAt clamps out-of-range rows & columns', () =>
{
  const value = 'ab\ncd'
  const starts = buildLineStarts(value)

  assert.equal(offsetAt(value, starts, { row: 9, col: 0 }), 3)
  assert.equal(offsetAt(value, starts, { row: 0, col: 99 }), 2)
  assert.equal(offsetAt(value, starts, { row: -3, col: -2 }), 0)
})

test('verticalMove walks rows keeping column intent', () =>
{
  const value = 'abcdef\nxy\nlonger line here'
  const starts = buildLineStarts(value)

  // from end of row 0 down: lands on 'xy' end, remembers col 6
  let move = verticalMove(value, starts, 6, 1, null)
  assert.equal(move.offset, 9)
  assert.equal(move.preferredCol, 6)

  // continuing down restores the remembered column
  move = verticalMove(value, starts, 9, 1, move.preferredCol)
  assert.equal(move.offset, 16)
  assert.equal(move.preferredCol, 6)

  // back up twice returns to the original spot
  const up = verticalMove(value, starts, move.offset, -2, move.preferredCol)
  assert.equal(up.offset, 6)
})

test('verticalMove stops at first/last-line boundaries', () =>
{
  const value = 'one\ntwo'
  const starts = buildLineStarts(value)

  assert.equal(verticalMove(value, starts, 2, -1, null).offset, 2)
  assert.equal(verticalMove(value, starts, 4, 1, null).offset, 4)
})

test('verticalMove never splits surrogate pairs', () =>
{
  // '𝕩' is a surrogate pair occupying columns 2-3 of its line
  const value = 'ab\ncd𝕩ef'
  const starts = buildLineStarts(value)

  // a column landing mid-pair snaps onto the pair's leading half
  const moved = verticalMove(value, starts, 2, 1, 3)
  assert.equal(moved.offset, 5)
})
