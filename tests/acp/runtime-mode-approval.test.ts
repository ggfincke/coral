// tests/acp/runtime-mode-approval.test.ts
// runtime modes and session grants decide ACP approvals through the projection

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AgentContext } from '@agentclientprotocol/sdk/unstable'
import { AcpEventProjection, AcpIdAllocator } from '../../src/acp/events.js'
import type { CoralRuntimeMode } from '../../src/acp/session-policy.js'

interface PermissionRequest
{
  options: Array<{ optionId: string; kind: string }>
}

function makeProjection(answer: 'allow_once' | 'allow_always')
{
  let mode: CoralRuntimeMode = 'approval-required'
  const requests: PermissionRequest[] = []
  const client = {
    async notify(): Promise<void>
    {},
    async request(_method: string, params: unknown): Promise<unknown>
    {
      const request = params as PermissionRequest
      requests.push(request)
      const option =
        request.options.find((entry) => entry.kind === answer) ??
        request.options.find((entry) => entry.kind === 'reject_once')!
      return { outcome: { outcome: 'selected', optionId: option.optionId } }
    },
  } as unknown as AgentContext
  const projection = new AcpEventProjection(
    {
      sessionId: 'session-1',
      cwd: '/workspace',
      client,
      signal: new AbortController().signal,
      isCurrent: () => true,
      getTodos: () => [],
      getContextWindow: () => 32_768,
      getRuntimeMode: () => mode,
      sessionToolGrants: new Set(),
    },
    new AcpIdAllocator('session-1')
  )
  const events = projection.events()
  let nextId = 0
  const approve = async (
    name: string,
    outside: boolean | undefined,
    protectedPath: boolean | undefined = false
  ) =>
  {
    const id = nextId++
    const args = { path: 'a.txt' }
    events.onToolCall(name, args, id)
    const before = requests.length
    const approved = await events.onToolApproval(
      name,
      args,
      undefined,
      id,
      outside,
      protectedPath
    )
    return { approved, prompts: requests.length - before }
  }
  return {
    approve,
    requests,
    setMode: (next: CoralRuntimeMode) =>
    {
      mode = next
    },
  }
}

test('runtime modes auto-approve only what each mode promises', async () =>
{
  const acp = makeProjection('allow_once')
  const rows: Array<
    [CoralRuntimeMode, string, boolean | undefined, boolean, boolean]
  > = [
    ['auto-accept-edits', 'write_file', false, false, true],
    ['auto-accept-edits', 'edit_file', false, false, true],
    ['auto-accept-edits', 'edit_file', true, false, false],
    ['auto-accept-edits', 'edit_file', undefined, false, false],
    ['auto-accept-edits', 'edit_file', false, true, false],
    ['auto-accept-edits', 'bash', false, false, false],
    ['auto-accept-edits', 'git_commit', false, false, false],
    ['auto-accept-edits', 'mcp__x__write_file', false, false, false],
    ['approval-required', 'write_file', false, false, false],
    ['full-access', 'bash', true, false, true],
    ['full-access', 'edit_file', false, true, true],
  ]
  for (const [mode, name, outside, protectedPath, auto] of rows)
  {
    acp.setMode(mode)
    const result = await acp.approve(name, outside, protectedPath)
    const label = `${mode} ${name} outside=${outside} protected=${protectedPath}`
    assert.equal(result.prompts, auto ? 0 : 1, label)
    assert.equal(result.approved, true, label)
  }
})

test('allow_always grants cover only the same tool and scope, never protected calls', async () =>
{
  const acp = makeProjection('allow_always')
  assert.deepEqual(await acp.approve('bash', false), {
    approved: true,
    prompts: 1,
  })
  assert.deepEqual(await acp.approve('bash', false), {
    approved: true,
    prompts: 0,
  })
  assert.equal((await acp.approve('git_push', false)).prompts, 1)

  // an in-workspace grant does not cover an outside-workspace call
  assert.equal((await acp.approve('write_file', false)).prompts, 1)
  assert.equal((await acp.approve('write_file', false)).prompts, 0)
  assert.equal((await acp.approve('write_file', true)).prompts, 1)
  assert.equal((await acp.approve('write_file', true)).prompts, 0)

  // a protected call ignores grants and is never offered allow_always
  const protectedCall = await acp.approve('write_file', false, true)
  assert.equal(protectedCall.prompts, 1)
  assert.equal(protectedCall.approved, false)
  assert.ok(
    acp.requests
      .at(-1)!
      .options.every((option) => option.kind !== 'allow_always')
  )
})
