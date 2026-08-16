// tests/tui/model-picker.test.ts
// backend labels and default pin via ModelRef, not the -mlx suffix

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import stripAnsi from 'strip-ansi'
import {
  buildModelPickerLines,
  formatPickerModelName,
  sortModels,
} from '../../src/tui/model/model-picker.js'
import type { Model } from '../../src/types/inference.js'

function listed(name: string, modifiedAt: string): Model
{
  return {
    name,
    model: name,
    size: 1,
    modified_at: modifiedAt,
  }
}

test('picker labels include the backend and pin gemma4:31b-mlx as Ollama', () =>
{
  assert.equal(
    formatPickerModelName(listed('ollama:gemma4:31b-mlx', '')),
    'gemma4:31b-mlx  (ollama)'
  )
  assert.equal(
    formatPickerModelName(listed('mlx:qwen3-coder', '')),
    'qwen3-coder  (mlx)'
  )

  const sorted = sortModels([
    listed('mlx:qwen3-coder', '2026-08-14T00:00:00.000Z'),
    listed('ollama:other', '2026-08-14T00:00:00.000Z'),
    listed('ollama:gemma4:31b-mlx', '2026-01-01T00:00:00.000Z'),
  ])
  assert.equal(sorted[0]?.name, 'ollama:gemma4:31b-mlx')
})

test('long backend warnings cannot hide the selected model row', () =>
{
  const models = Array.from({ length: 10 }, (_, index) =>
    listed(
      `ollama:model-${index}`,
      `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
    )
  )
  const lines = buildModelPickerLines(
    models,
    5,
    40,
    15,
    `mlx: ${'worker installation failed '.repeat(30)}\x1b]52;c;SGVsbG8=\x07`
  )
  const rendered = stripAnsi(lines.join('\n'))

  assert.ok(lines.length <= 15)
  assert.match(rendered, /› model-5 {2}\(ollama\)/)
  assert.match(rendered, /mlx: worker installation failed/)
  assert.equal(
    rendered.includes(String.fromCharCode(27)) ||
      rendered.includes(String.fromCharCode(7)),
    false
  )
})
