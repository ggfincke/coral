// tests/tools/todo.test.ts
// parse and validate todo lists

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { sanitizeTodos, validateTodoList } from '../../src/types/todo.js'

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

test('sanitizeTodos drops invalid entries', () =>
{
  assert.deepEqual(sanitizeTodos(null), [])
  assert.deepEqual(sanitizeTodos(undefined), [])
  assert.deepEqual(sanitizeTodos('foo'), [])
  assert.deepEqual(sanitizeTodos({}), [])
  assert.deepEqual(
    sanitizeTodos([
      { content: '', status: 'pending' },
      { content: '  ', status: 'pending' },
      null,
      'bad',
      42,
      { content: 'ok', status: 'pending' },
      { content: 'x', status: 'done' },
      { content: 'y', status: 'pending' },
    ]),
    [
      { content: 'ok', status: 'pending' },
      { content: 'y', status: 'pending' },
    ]
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

test('validateTodoList rejects invalid todo lists', () =>
{
  const nonArray = validateTodoList(null)
  assert.equal(nonArray.ok, false)
  if (!nonArray.ok)
  {
    assert.equal(nonArray.error, 'todo_write requires a todos array')
  }

  const nonObject = validateTodoList([null])
  assert.equal(nonObject.ok, false)
  if (!nonObject.ok)
  {
    assert.equal(nonObject.error, 'each todo must be an object')
  }

  const emptyContent = validateTodoList([{ content: '  ', status: 'pending' }])
  assert.equal(emptyContent.ok, false)
  if (!emptyContent.ok)
  {
    assert.equal(emptyContent.error, 'each todo needs a non-empty content string')
  }

  const badStatus = validateTodoList([{ content: 'x', status: 'done' }])
  assert.equal(badStatus.ok, false)
  if (!badStatus.ok)
  {
    assert.equal(
      badStatus.error,
      'each todo status must be pending, in_progress, or completed'
    )
  }

  const multiProgress = validateTodoList([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
  ])
  assert.equal(multiProgress.ok, false)
  if (!multiProgress.ok)
  {
    assert.equal(
      multiProgress.error,
      'only one todo may be in_progress at a time'
    )
  }
})
