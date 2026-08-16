// tests/skills/skills.test.ts
// discover, confined load, user instructions, and skills CLI path/seed

import { strict as assert } from 'node:assert'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { runSkillsCli, SKILLS_SEED_HINT } from '../../src/cli/skills.js'
import {
  discoverSkills,
  loadSkillFile,
  loadUserInstructions,
} from '../../src/skills/discover.js'
import { agentsHomePath } from '../../src/utils/agents-home.js'
import { captureAgentsHome } from '../helpers/agents-home.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()
const restoreAgentsHome = captureAgentsHome()

after(() =>
{
  restoreAgentsHome()
})

async function writeSkill(
  root: string,
  name: string,
  options: {
    description?: string
    body?: string
    frontmatter?: string
    extraFiles?: Record<string, string>
  } = {}
): Promise<string>
{
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  const frontmatter =
    options.frontmatter ??
    `---\nname: ${name}\ndescription: ${options.description ?? `${name} skill`}\n---\n`
  await writeFile(
    join(dir, 'SKILL.md'),
    `${frontmatter}${options.body ?? `# ${name}\n`}`,
    'utf-8'
  )
  for (const [relative, content] of Object.entries(options.extraFiles ?? {}))
  {
    const path = join(dir, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content, 'utf-8')
  }
  return dir
}

describe('discoverSkills', () =>
{
  test('later roots override on name collision and skip invalid packages', async () =>
  {
    const agentsHome = await tempDir('coral-skills-agents-home-')
    const coralHome = await tempDir('coral-skills-coral-home-')
    const cwd = await tempDir('coral-skills-cwd-')
    await writeSkill(join(agentsHome, 'skills'), 'shared', {
      description: 'from user home',
    })
    await writeSkill(join(agentsHome, 'skills'), 'only-user', {
      description: 'user only',
    })
    await writeSkill(join(coralHome, 'skills'), 'from-coral-home', {
      description: 'must not be discovered',
    })
    await writeSkill(join(cwd, '.agents', 'skills'), 'shared', {
      description: 'from project-agents',
    })
    await writeSkill(join(cwd, '.coral', 'skills'), 'shared', {
      description: 'from project-coral',
    })
    await mkdir(join(agentsHome, 'skills', 'broken'), { recursive: true })
    await writeFile(
      join(agentsHome, 'skills', 'broken', 'SKILL.md'),
      '# no yaml\n'
    )
    await writeSkill(join(agentsHome, 'skills'), 'oversized', {
      body: 'x'.repeat(1_048_577),
    })
    const outside = join(agentsHome, 'outside-skill.md')
    await writeFile(
      outside,
      '---\nname: escaped\ndescription: escaped file\n---\n',
      'utf-8'
    )
    const escapedDir = join(agentsHome, 'skills', 'escaped')
    await mkdir(escapedDir, { recursive: true })
    await symlink(outside, join(escapedDir, 'SKILL.md'))

    const index = discoverSkills({ cwd, agentsHome })
    assert.equal(index.get('shared')?.description, 'from project-coral')
    assert.equal(index.get('shared')?.source, 'project-coral')
    assert.equal(index.get('only-user')?.source, 'user')
    assert.equal(index.get('broken'), undefined)
    assert.equal(index.get('oversized'), undefined)
    assert.equal(index.get('escaped'), undefined)
    assert.equal(index.get('from-coral-home'), undefined)
    assert.equal(index.size, 2)
  })

  test('allows a symlink skill package and rejects `..` loads', async () =>
  {
    const agentsHome = await tempDir('coral-skills-link-home-')
    const cwd = await tempDir('coral-skills-link-cwd-')
    const real = await writeSkill(join(agentsHome, 'real-skills'), 'linked', {
      description: 'linked package',
      extraFiles: { 'references/ok.md': '# inside\n' },
    })
    const skillsDir = join(agentsHome, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await symlink(real, join(skillsDir, 'linked'))
    await writeFile(join(agentsHome, 'secret.md'), 'nope\n', 'utf-8')

    const index = discoverSkills({ cwd, agentsHome })
    const record = index.get('linked')
    assert.ok(record)
    const ok = loadSkillFile(record, 'references/ok.md')
    assert.equal(ok.ok, true)
    if (ok.ok) assert.match(ok.content, /inside/)

    const escaped = loadSkillFile(record, '../secret.md')
    assert.equal(escaped.ok, false)
    if (!escaped.ok)
    {
      assert.match(escaped.error, /relative path inside the skill package/)
    }
  })
})

describe('loadUserInstructions', () =>
{
  test('reads AGENTS_HOME/AGENTS.md and ignores CORAL_HOME/AGENTS.md', async () =>
  {
    const agentsHome = await tempDir('coral-skills-agents-md-')
    const coralHome = await tempDir('coral-skills-coral-md-')
    await writeFile(
      join(agentsHome, 'AGENTS.md'),
      'FROM-AGENTS-HOME\n',
      'utf-8'
    )
    await writeFile(join(coralHome, 'AGENTS.md'), 'FROM-CORAL-HOME\n', 'utf-8')

    const text = loadUserInstructions(agentsHome)
    assert.match(text, /FROM-AGENTS-HOME/)
    assert.doesNotMatch(text, /FROM-CORAL-HOME/)
    assert.equal(
      loadUserInstructions(await tempDir('coral-skills-empty-md-')),
      ''
    )

    await writeFile(
      join(agentsHome, 'AGENTS.md'),
      `BOUNDED\n${'x'.repeat(2_000_000)}`,
      'utf-8'
    )
    const bounded = loadUserInstructions(agentsHome)
    assert.match(bounded, /^BOUNDED/)
    assert.match(bounded, /truncated/)
    assert.ok(Buffer.byteLength(bounded, 'utf-8') < 9_000)
  })
})

describe('coral skills CLI', () =>
{
  test('path prints AGENTS_HOME/skills and seed fails with a sync pointer', async () =>
  {
    const agentsHome = await tempDir('coral-skills-cli-home-')
    process.env.AGENTS_HOME = agentsHome
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      writeStdout: (text: string) =>
      {
        stdout.push(text)
      },
      writeStderr: (text: string) =>
      {
        stderr.push(text)
      },
    }
    try
    {
      await writeSkill(join(agentsHome, 'skills'), 'terminal\nroot', {
        frontmatter: `---\nname: terminal-safe\ndescription: safe\x1b]52;c;SGVsbG8=\x07text ${'x'.repeat(10_000)}\n---\n`,
      })
      const listCode = await runSkillsCli(['list'], io)
      assert.equal(listCode, 0)
      const listOutput = stdout.join('')
      assert.equal(
        listOutput.includes(String.fromCharCode(27)) ||
          listOutput.includes(String.fromCharCode(7)),
        false
      )
      assert.match(listOutput, /terminal root/)
      const listLines = listOutput.trimEnd().split('\n')
      assert.ok(Math.max(...listLines.map((line) => line.length)) < 500)
      const terminalLine = listLines.findIndex((line) =>
        line.startsWith('terminal-safe  ')
      )
      assert.ok(terminalLine >= 0)
      assert.ok(listLines[terminalLine + 1]!.length <= 242)
      stdout.length = 0

      const pathCode = await runSkillsCli(['path'], io)
      assert.equal(pathCode, 0)
      assert.equal(stdout.join('').trim(), agentsHomePath('skills'))
      assert.equal(stdout.join('').trim(), join(agentsHome, 'skills'))

      const seedCode = await runSkillsCli(['seed'], io)
      assert.equal(seedCode, 1)
      assert.equal(stderr.join('').trim(), SKILLS_SEED_HINT)
      assert.match(SKILLS_SEED_HINT, /sync-skills\.py --target agents/)
    }
    finally
    {
      restoreAgentsHome()
    }
  })
})
