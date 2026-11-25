// tests/tui/approval-controls.test.ts
// approval prompts show every byte that will run and name what a call touches

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import stripAnsi from 'strip-ansi'
import { allTools } from '../../src/tools/registry.js'
import { ToolCatalog } from '../../src/tools/catalog.js'
import { computeDiff } from '../../src/utils/diff.js'
import {
  buildApprovalContent,
  renderPromptBox,
} from '../../src/tui/run/approval-box.js'

const catalog = new ToolCatalog({ trustedTools: allTools })
const HIDDEN_WARNING = /control or invisible characters/

function approvalText(
  toolName: string,
  args: Record<string, unknown>,
  diff?: string
): string
{
  const content = buildApprovalContent(
    toolName,
    args,
    120,
    diff,
    undefined,
    catalog.presentationFor(toolName, args)
  )
  return stripAnsi(renderPromptBox(content, 120, 200, 0).lines.join('\n'))
}

test('OSC-wrapped bash text stays visible on the approval prompt', () =>
{
  const text = approvalText('bash', {
    command: 'ls\u001b]; rm -rf x; :\u0007',
  })
  assert.match(text, /rm -rf x/)
  assert.match(text, /ls\\x1b\]; rm -rf x; :\\x07/)
  assert.match(text, HIDDEN_WARNING)
  assert.ok(!text.includes('\u001b]'))
})

test('a write_file diff with an OSC-wrapped line shows every added line', () =>
{
  const content = 'echo ok \u001b]\necho hidden-line\n: \u0007\necho done\n'
  const diff = computeDiff('', content)
  assert.ok(diff)
  const text = approvalText('write_file', { path: 'setup.sh', content }, diff)
  for (const line of ['echo ok', 'echo hidden-line', ': \\x07', 'echo done'])
  {
    assert.ok(text.includes(line), `missing ${line}`)
  }
  assert.match(text, HIDDEN_WARNING)
})

test('a multi-line command with tabs renders unchanged and without a warning', () =>
{
  const command = 'for f in *.ts\ndo\n\techo "$f"\ndone'
  const content = buildApprovalContent(
    'bash',
    { command },
    120,
    undefined,
    undefined,
    catalog.presentationFor('bash', { command })
  )
  assert.equal(stripAnsi(content.bodyLines.join('\n')), `$ ${command}`)
  assert.doesNotMatch(stripAnsi(content.titleLines.join('\n')), HIDDEN_WARNING)
})

test('approval summaries name the glob path and every git_add path', () =>
{
  assert.match(
    approvalText('glob', { pattern: '**/*.pem', path: '/etc/ssl' }),
    /\*\*\/\*\.pem \/etc\/ssl/
  )
  assert.match(
    approvalText('git_add', { paths: '["secrets.env","b.txt"]' }),
    /secrets\.env, b\.txt/
  )
})
