// tests/cli/app-launch.test.ts
// validate CLI host before Ink application composition

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { launchCliApp } from '../../src/cli/app-launch.js'

test('explicit-model launch rejects an invalid host before rendering', () =>
{
  let rendered = false
  const errors: string[] = []

  const exitCode = launchCliApp(
    {
      model: 'test-model',
      host: 'not-a-url',
      think: true,
      yolo: false,
    },
    () =>
    {
      rendered = true
    },
    (message) => errors.push(message)
  )

  assert.equal(exitCode, 1)
  assert.equal(rendered, false)
  assert.deepEqual(errors, [
    'Cannot start Coral: Invalid Ollama host URL: not-a-url',
  ])
})

test('CLI launch passes the canonical host into the Ink composition', () =>
{
  let seenHost = ''
  const exitCode = launchCliApp(
    {
      model: 'test-model',
      host: 'HTTP://OLLAMA.TEST:80/proxy///',
      think: true,
      yolo: false,
    },
    (props) =>
    {
      seenHost = props.host
    },
    () => assert.fail('valid host should not report an error')
  )

  assert.equal(exitCode, 0)
  assert.equal(seenHost, 'http://ollama.test/proxy')
})

test('CLI launch canonicalizes model refs and fails closed on unknown backends', () =>
{
  let seenModel = ''
  const ok = launchCliApp(
    {
      model: 'gemma4:31b-mlx',
      host: 'http://localhost:11434',
      think: true,
      yolo: false,
    },
    (props) =>
    {
      seenModel = props.model ?? ''
    },
    () => assert.fail('valid model should not report an error')
  )
  assert.equal(ok, 0)
  assert.equal(seenModel, 'ollama:gemma4:31b-mlx')

  const errors: string[] = []
  const failed = launchCliApp(
    {
      model: 'foo:bar',
      host: 'http://localhost:11434',
      think: true,
      yolo: false,
    },
    () => assert.fail('unknown backend should not render'),
    (message) => errors.push(message)
  )
  assert.equal(failed, 1)
  assert.match(errors[0] ?? '', /Unknown model backend "foo"/)
})
