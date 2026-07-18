// tests/tools/todo.test.ts
// todo parsing & validation contracts

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { sanitizeTodos, validateTodoList } from '../../src/types/todo.js'

// --- sanitizeTodos (lenient restore path) ---

test('sanitizeTodos returns valid items with trimmed content', () =>
{
  const input = [
    { content: '  hello  ', status: 'pending' },
    { content: 'world', status: 'completed' },
  ]
  assert.deepEqual(sanitizeTodos(input), [
    { content: 'hello', status: 'pending' },
    { content: 'world', status: 'completed' },
  ])
})

test('sanitizeTodos returns [] for non-array input', () =>
{
  assert.deepEqual(sanitizeTodos(null), [])
  assert.deepEqual(sanitizeTodos(undefined), [])
  assert.deepEqual(sanitizeTodos('foo'), [])
  assert.deepEqual(sanitizeTodos({}), [])
})

test('sanitizeTodos drops garbage entries', () =>
{
  assert.deepEqual(
    sanitizeTodos([
      { content: '', status: 'pending' },
      { content: '  ', status: 'pending' },
      null,
      'bad',
      42,
      { content: 'ok', status: 'pending' },
    ]),
    [{ content: 'ok', status: 'pending' }]
  )
})

test('sanitizeTodos drops entries with invalid status', () =>
{
  assert.deepEqual(
    sanitizeTodos([
      { content: 'x', status: 'done' },
      { content: 'y', status: 'pending' },
    ]),
    [{ content: 'y', status: 'pending' }]
  )
})

test('sanitizeTodos demotes extra in_progress entries to pending', () =>
{
  assert.deepEqual(
    sanitizeTodos([
      { content: 'first', status: 'in_progress' },
      { content: 'second', status: 'in_progress' },
      { content: 'third', status: 'in_progress' },
    ]),
    [
      { content: 'first', status: 'in_progress' },
      { content: 'second', status: 'pending' },
      { content: 'third', status: 'pending' },
    ]
  )
})

// --- validateTodoList (strict todo_write path) ---

test('validateTodoList accepts a valid array', () =>
{
  const result = validateTodoList([
    { content: '  task  ', status: 'in_progress' },
    { content: 'done', status: 'completed' },
  ])
  assert.equal(result.ok, true)
  if (result.ok)
  {
    assert.deepEqual(result.todos, [
      { content: 'task', status: 'in_progress' },
      { content: 'done', status: 'completed' },
    ])
  }
})

test('validateTodoList rejects non-array input', () =>
{
  const result = validateTodoList(null)
  assert.equal(result.ok, false)
  if (!result.ok)
  {
    assert.equal(result.error, 'todo_write requires a todos array')
  }
})

test('validateTodoList rejects non-object entries', () =>
{
  const result = validateTodoList([null])
  assert.equal(result.ok, false)
  if (!result.ok)
  {
    assert.equal(result.error, 'each todo must be an object')
  }
})

test('validateTodoList rejects empty content', () =>
{
  const result = validateTodoList([{ content: '  ', status: 'pending' }])
  assert.equal(result.ok, false)
  if (!result.ok)
  {
    assert.equal(result.error, 'each todo needs a non-empty content string')
  }
})

test('validateTodoList rejects invalid status', () =>
{
  const result = validateTodoList([{ content: 'x', status: 'done' }])
  assert.equal(result.ok, false)
  if (!result.ok)
  {
    assert.equal(
      result.error,
      'each todo status must be pending, in_progress, or completed'
    )
  }
})

test('validateTodoList rejects more than one in_progress', () =>
{
  const result = validateTodoList([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
  ])
  assert.equal(result.ok, false)
  if (!result.ok)
  {
    assert.equal(result.error, 'only one todo may be in_progress at a time')
  }
})
