// tests/tui/export-theme-commands.test.ts
// export expands ~ to the home dir & theme repaints even when prefs cannot be saved

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { CommandContext } from '../../src/tui/commands/contracts.js'
import { conversationCommands } from '../../src/tui/commands/conversation.js'
import { runtimeCommands } from '../../src/tui/commands/runtime.js'
import { getTheme, setTheme } from '../../src/tui/theme.js'
import { THEMES } from '../../src/tui/themes.js'
import type { OutputBlock } from '../../src/tui/transcript/types.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()
const originalHome = process.env.HOME
const restoreCoralHome = captureCoralHome()
const originalTheme = getTheme()

after(() =>
{
  process.env.HOME = originalHome
  restoreCoralHome()
  setTheme(originalTheme)
})

function systemText(blocks: OutputBlock[]): string
{
  return blocks
    .map((block) => (block as { content: string }).content)
    .join('\n')
}

test('/export --file ~/notes.md writes under the home directory', async () =>
{
  const home = await tempDir('coral-export-home-')
  const cwd = await tempDir('coral-export-cwd-')
  process.env.HOME = home
  const output: OutputBlock[] = []
  const ctx = {
    agent: {
      getMessages: () => [{ role: 'user', content: 'hello' }],
      getUndoStack: () => [],
    },
    getCwd: () => cwd,
    pushOutput: (...blocks: OutputBlock[]) => output.push(...blocks),
  } as unknown as CommandContext

  await conversationCommands.export.execute('--file ~/notes.md', ctx)

  assert.match(systemText(output), /^Exported Markdown to /)
  assert.match(readFileSync(join(home, 'notes.md'), 'utf-8'), /hello/)
  assert.equal(existsSync(join(cwd, '~')), false)
})

test('/theme notifies the repaint and reports an unsaved theme when prefs fail', async () =>
{
  const dir = await tempDir('coral-theme-prefs-')
  const blocker = join(dir, 'not-a-dir')
  writeFileSync(blocker, '')
  process.env.CORAL_HOME = join(blocker, 'coral')
  const next = THEMES.find((theme) => theme !== getTheme())!
  const output: OutputBlock[] = []
  let notified = 0
  const ctx = {
    notifyThemeChanged: () => notified++,
    pushOutput: (...blocks: OutputBlock[]) => output.push(...blocks),
  } as unknown as CommandContext

  await runtimeCommands.theme.execute(next.name, ctx)

  assert.equal(getTheme(), next)
  assert.equal(notified, 1)
  assert.match(systemText(output), /applied, but not saved to prefs/)
})
