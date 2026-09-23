// tests/acp/protocol-helpers.test.ts
// protect Coral's ACP input, model, permission, and event contracts

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type {
  AgentContext,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import { AcpEventProjection, AcpIdAllocator } from '../../src/acp/events.js'
import {
  availableModelNames,
  buildModelConfigOption,
  selectedModelFromRequest,
} from '../../src/acp/model-config.js'
import { normalizeAcpPrompt } from '../../src/acp/prompt.js'
import {
  buildInteractionModes,
  buildRuntimeModeConfigOption,
  selectedInteractionMode,
  selectedRuntimeMode,
} from '../../src/acp/session-policy.js'

test('prompt normalization accepts text and rejects every non-text block', () =>
{
  assert.equal(
    normalizeAcpPrompt([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]),
    'first\n\nsecond'
  )

  assert.throws(
    () =>
      normalizeAcpPrompt([
        {
          type: 'resource_link',
          name: 'README',
          uri: 'file:///workspace/README.md',
        },
      ]),
    /Coral supports text only/
  )
})

test('model configuration uses exact installed identities', () =>
{
  const names = availableModelNames([
    {
      name: 'newer',
      size: 1,
      modified_at: '2026-01-02T00:00:00.000Z',
    },
    {
      name: 'gemma4:31b-mlx',
      size: 1,
      modified_at: '2025-01-01T00:00:00.000Z',
    },
  ])
  const option = buildModelConfigOption('gemma4:31b-mlx', names)

  assert.deepEqual(names, ['gemma4:31b-mlx', 'newer'])
  assert.equal(option.type, 'select')
  assert.equal(option.currentValue, 'gemma4:31b-mlx')
  assert.equal(
    selectedModelFromRequest(
      {
        sessionId: 'session',
        configId: 'model',
        value: 'newer',
      },
      names
    ),
    'newer'
  )
  assert.throws(
    () =>
      selectedModelFromRequest(
        {
          sessionId: 'session',
          configId: 'model',
          value: 'missing',
        },
        names
      ),
    /Unknown Ollama model/
  )
})

test('session policy advertises supervised operation and rejects other modes', () =>
{
  assert.deepEqual(
    buildInteractionModes('default').availableModes.map((mode) => mode.id),
    ['default']
  )
  const option = buildRuntimeModeConfigOption('approval-required')
  assert.deepEqual(
    option.type === 'select'
      ? option.options.map((entry) => 'value' in entry && entry.value)
      : [],
    ['approval-required']
  )
  assert.throws(() => selectedInteractionMode('plan'), /Unsupported/)
  for (const value of ['auto', 'full-access', 'auto-accept-edits'])
    assert.throws(
      () =>
        selectedRuntimeMode({
          sessionId: 'session',
          configId: 'coral.runtime-mode',
          value,
        }),
      /only approval-required/
    )
})

test('event projection preserves exact tool identity and session permission', async () =>
{
  const notifications: SessionNotification[] = []
  const permissionRequests: unknown[] = []
  const client = {
    async notify(_method: string, params: SessionNotification): Promise<void>
    {
      notifications.push(params)
    },
    async request(_method: string, params: unknown): Promise<unknown>
    {
      permissionRequests.push(params)
      const options = (
        params as { options: Array<{ optionId: string; kind: string }> }
      ).options
      return {
        outcome: {
          outcome: 'selected',
          optionId: options.find((option) => option.kind === 'allow_once')!
            .optionId,
        },
      }
    },
  } as unknown as AgentContext
  const signal = new AbortController().signal
  const projection = new AcpEventProjection(
    {
      sessionId: 'session-1',
      cwd: '/workspace',
      client,
      signal,
      isCurrent: () => true,
      getTodos: () => [],
      getContextWindow: () => 32_768,
    },
    new AcpIdAllocator('session-1')
  )
  const events = projection.events()
  const args = { query: 'needle', toolName: 'attacker-controlled' }

  events.onToolCall('search_code', args, 0)
  assert.equal(
    await events.onToolApproval('search_code', args, undefined, 0),
    true
  )
  assert.equal(
    await events.onToolApproval('search_code', args, undefined, 0),
    false
  )
  assert.equal(
    await events.onToolApproval('search_code', args, undefined, undefined),
    false
  )
  events.onToolResult('search_code', 'match', undefined, 0)
  await projection.drain()

  assert.equal(permissionRequests.length, 1)
  assert.equal(notifications.length, 2)
  assert.deepEqual(notifications[0]!.update, {
    sessionUpdate: 'tool_call',
    toolCallId: (notifications[0]!.update as { toolCallId: string }).toolCallId,
    title: 'search_code',
    kind: 'search',
    status: 'pending',
    locations: undefined,
    rawInput: {
      toolName: 'search_code',
      arguments: args,
    },
  })
  assert.deepEqual(
    (
      permissionRequests[0] as {
        toolCall: { rawInput: unknown }
        options: Array<{ kind: string }>
      }
    ).toolCall.rawInput,
    {
      toolName: 'search_code',
      arguments: args,
    }
  )
  assert.deepEqual(
    (
      permissionRequests[0] as {
        options: Array<{ kind: string }>
      }
    ).options.map((option) => option.kind),
    ['allow_once', 'reject_once']
  )
})
