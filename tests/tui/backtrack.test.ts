// tests/tui/backtrack.test.ts
// esc-esc backtrack turn derivation, previews, and selector key handling

import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import stripAnsi from 'strip-ansi'
import {
  buildBacktrackLines,
  buildBacktrackTurns,
  previewBacktrackTurn,
  reduceBacktrackInput,
} from '../../src/tui/transcript/backtrack.js'
import type { OllamaMessage } from '../../src/types/inference.js'

describe('backtrack selector', () =>
{
  test('buildBacktrackTurns pairs user prompts with message indexes', () =>
  {
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'system prompt' },
      {
        role: 'user',
        content: 'expanded attachment bytes',
        displayContent: '@big.txt summarize',
      },
      { role: 'assistant', content: 'working' },
      { role: 'tool', content: 'result', tool_name: 'read_file' },
      { role: 'user', content: 'second prompt' },
      { role: 'assistant', content: 'done' },
    ]

    assert.deepEqual(buildBacktrackTurns(messages), [
      { startIndex: 1, content: '@big.txt summarize' },
      { startIndex: 4, content: 'second prompt' },
    ])
  })

  test('previewBacktrackTurn collapses whitespace and caps length', () =>
  {
    assert.equal(
      previewBacktrackTurn('  fix\n\nthe   login bug\ttoday  '),
      'fix the login bug today'
    )

    const preview = previewBacktrackTurn('a'.repeat(200))
    assert.equal(preview.length, 80)
    assert.ok(preview.endsWith('…'))
    assert.equal(previewBacktrackTurn(''), '')
  })

  test('reduceBacktrackInput moves by arrows and pages within bounds', () =>
  {
    assert.deepEqual(
      reduceBacktrackInput({ selectedIndex: 1 }, { downArrow: true }, 3),
      { handled: true, state: { selectedIndex: 2 } }
    )
    // downArrow clamps at the last row
    assert.equal(
      reduceBacktrackInput({ selectedIndex: 2 }, { downArrow: true }, 3).state
        .selectedIndex,
      2
    )
    assert.deepEqual(
      reduceBacktrackInput({ selectedIndex: 5 }, { pageDown: true }, 30),
      { handled: true, state: { selectedIndex: 15 } }
    )
    // pageUp clamps at the first row
    assert.equal(
      reduceBacktrackInput({ selectedIndex: 2 }, { pageUp: true }, 30).state
        .selectedIndex,
      0
    )
    assert.deepEqual(reduceBacktrackInput({ selectedIndex: 1 }, {}, 3), {
      handled: false,
      state: { selectedIndex: 1 },
    })
  })

  test('buildBacktrackLines keeps the selected turn visible in short viewports', () =>
  {
    const turns = buildBacktrackTurns([
      { role: 'system', content: 'system prompt' },
      ...['first', 'second', 'third', 'fourth', 'fifth'].flatMap(
        (prompt): OllamaMessage[] => [
          { role: 'user', content: `${prompt} prompt` },
          { role: 'assistant', content: `${prompt} answer` },
        ]
      ),
    ])

    const lines = buildBacktrackLines({
      turns,
      selectedIndex: 4,
      width: 40,
      height: 6,
    })
    const rendered = stripAnsi(lines.join('\n'))
    assert.match(rendered, /backtrack/)
    assert.match(rendered, /› fifth prompt/)
    assert.doesNotMatch(rendered, /› first prompt/)

    const empty = stripAnsi(
      buildBacktrackLines({
        turns: [],
        selectedIndex: 0,
        width: 40,
        height: 6,
      }).join('\n')
    )
    assert.match(empty, /no earlier prompts/)
  })
})
