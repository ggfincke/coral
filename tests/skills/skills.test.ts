// tests/skills/skills.test.ts
// major Agent Skills discovery, prompt, invocation, and lifetime contracts

import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import stripAnsi from 'strip-ansi'
import {
  buildSystemPrompt,
  SKILL_CATALOG_MAX_BYTES,
  USER_INSTRUCTIONS_MAX_BYTES,
} from '../../src/agent/request/system-prompt.js'
import { ConversationState } from '../../src/agent/state/conversation.js'
import { formatSkillsList } from '../../src/cli/skills.js'
import { createSession, loadSession } from '../../src/session/store.js'
import {
  discoverSkills,
  loadUserInstructions,
} from '../../src/skills/discover.js'
import { SkillIndex, type SkillRecord } from '../../src/skills/types.js'
import { ToolCatalog } from '../../src/tools/catalog.js'
import { createSkillTool } from '../../src/tools/skill.js'
import type { OllamaMessage } from '../../src/types/inference.js'
import {
  commandCompletions,
  resolveSlashSkill,
  type SlashSkillResolution,
} from '../../src/tui/commands/registry.js'
import { formatSkillsStatus } from '../../src/tui/commands/runtime-output.js'
import { buildRestoredBlocks } from '../../src/tui/transcript/restored-blocks.js'
import { makeFakeAgent, makeAgentEvents } from '../helpers/agent-harness.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()
const execFileAsync = promisify(execFile)

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

async function writeSkill(
  root: string,
  name: string,
  description: string,
  body = ''
): Promise<void>
{
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body || `${name} body`}\n`,
    'utf-8'
  )
}

function skillRecord(root: string, name = 'Review'): SkillRecord
{
  return {
    name,
    description: 'Review the requested change.',
    source: 'user',
    root,
  }
}

function requireSkillResolution(
  resolution: SlashSkillResolution | null
): Extract<SlashSkillResolution, { kind: 'skill' }>
{
  assert.equal(resolution?.kind, 'skill')
  return resolution as Extract<SlashSkillResolution, { kind: 'skill' }>
}

test('discovery confines project roots and packages while allowing personal symlinks', async () =>
{
  const fixture = await tempDir('coral-skill-confinement-')
  const cwd = join(fixture, 'project')
  const agentsHome = join(fixture, 'agents-home')
  const userSkills = join(agentsHome, 'skills')
  const projectAgents = join(cwd, '.agents', 'skills')
  const outsidePersonal = join(fixture, 'outside-personal')
  const movedPersonal = join(fixture, 'moved-personal')
  const retargetedPersonal = join(fixture, 'retargeted-personal')
  const outsideProject = join(fixture, 'outside-project')
  const outsideCoralRoot = join(fixture, 'outside-coral-root')
  const aliasedReferences = join(userSkills, 'aliased-references')

  await mkdir(projectAgents, { recursive: true })
  await mkdir(userSkills, { recursive: true })
  await mkdir(join(cwd, '.coral'), { recursive: true })
  await writeSkill(outsidePersonal, 'PersonalLink', 'allowed personal link')
  await mkdir(join(outsidePersonal, 'references'))
  await mkdir(join(outsidePersonal, 'scripts'))
  await writeFile(join(outsidePersonal, 'scripts', 'run.sh'), 'echo unsafe\n')
  await symlink(
    '../scripts/run.sh',
    join(outsidePersonal, 'references', 'leak')
  )
  await writeSkill(
    aliasedReferences,
    'AliasedReferences',
    'references must not alias scripts'
  )
  await mkdir(join(aliasedReferences, 'scripts'))
  await writeFile(join(aliasedReferences, 'scripts', 'run.sh'), 'echo unsafe\n')
  await symlink('scripts', join(aliasedReferences, 'references'))
  await writeSkill(outsideProject, 'AgentEscape', 'rejected package escape')
  await writeSkill(
    join(outsideCoralRoot, 'root-escape'),
    'CoralEscape',
    'rejected root escape'
  )
  await writeSkill(
    join(projectAgents, 'local'),
    'LocalProject',
    'allowed project package'
  )
  await symlink(outsidePersonal, join(userSkills, 'personal-link'))
  await symlink(
    relative(projectAgents, outsideProject),
    join(projectAgents, 'relative-escape')
  )
  await symlink(outsideCoralRoot, join(cwd, '.coral', 'skills'))

  // nonblocking opens let regular-file checks reject FIFOs without hanging
  if (process.platform !== 'win32')
  {
    const fifoPackage = join(userSkills, 'fifo')
    await mkdir(fifoPackage)
    await execFileAsync('mkfifo', [join(fifoPackage, 'SKILL.md')])
    await execFileAsync('mkfifo', [join(agentsHome, 'AGENTS.md')])
  }

  const index = discoverSkills({ cwd, agentsHome })

  assert.deepEqual(
    index.records.map((record) => record.name),
    ['AliasedReferences', 'LocalProject', 'PersonalLink']
  )
  assert.equal(index.get('personallink')?.root, await realpath(outsidePersonal))
  assert.equal(index.get('agentescape'), undefined)
  assert.equal(index.get('coralescape'), undefined)
  assert.equal(loadUserInstructions(agentsHome), '')
  const scriptLeak = await createSkillTool(index).execute({
    name: 'PersonalLink',
    file: 'references/leak',
  })
  assert.match(scriptLeak.error ?? '', /missing, unsafe, non-regular/)
  const directoryAlias = await createSkillTool(index).execute({
    name: 'AliasedReferences',
    file: 'references/run.sh',
  })
  assert.match(directoryAlias.error ?? '', /references directory.*unsafe/)

  await writeSkill(
    retargetedPersonal,
    'RetargetedPersonal',
    'must not replace the discovered package'
  )
  await rename(outsidePersonal, movedPersonal)
  await symlink(retargetedPersonal, outsidePersonal)
  const retargeted = await createSkillTool(index).execute({
    name: 'PersonalLink',
  })
  assert.match(retargeted.error ?? '', /skill package is unreadable/)
})

test('case-folded precedence keeps personal then Coral winners and reports every collision', async () =>
{
  const fixture = await tempDir('coral-skill-precedence-')
  const cwd = join(fixture, 'project')
  const agentsHome = join(fixture, 'agents-home')
  const user = join(agentsHome, 'skills', 'review-user')
  const coralReview = join(cwd, '.coral', 'skills', 'review-coral')
  const agentsReview = join(cwd, '.agents', 'skills', 'review-agents')
  const coralBuild = join(cwd, '.coral', 'skills', 'build-coral')
  const agentsBuild = join(cwd, '.agents', 'skills', 'build-agents')
  const sameFirst = join(agentsHome, 'skills', 'same-a')
  const sameSecond = join(agentsHome, 'skills', 'same-z')
  const status = join(agentsHome, 'skills', 'status-skill')
  await writeSkill(user, 'Review', 'personal winner', 'personal instructions')
  await writeSkill(coralReview, 'review', 'Coral project loser')
  await writeSkill(agentsReview, 'REVIEW', 'Agents project loser')
  await writeSkill(coralBuild, 'Build', 'Coral project winner')
  await writeSkill(agentsBuild, 'build', 'Agents project loser')
  await writeSkill(sameFirst, 'Same', 'same-source lexical winner')
  await writeSkill(sameSecond, 'same', 'same-source lexical loser')
  await writeSkill(status, 'status', 'must not replace the built-in command')

  const index = discoverSkills({ cwd, agentsHome })
  const reviewCollision = index.collisions.find(
    (collision) => collision.canonicalName === 'review'
  )
  const buildCollision = index.collisions.find(
    (collision) => collision.canonicalName === 'build'
  )

  assert.equal(index.get('rEvIeW')?.source, 'user')
  assert.equal(index.get('BUILD')?.source, 'project-coral')
  assert.equal(index.get('same')?.description, 'same-source lexical winner')
  assert.deepEqual(
    reviewCollision?.rejected.map((record) => record.source),
    ['project-coral', 'project-agents']
  )
  assert.deepEqual(
    buildCollision?.rejected.map((record) => record.source),
    ['project-agents']
  )
  assert.ok(Object.isFrozen(index.records))
  assert.ok(Object.isFrozen(index.collisions))
  assert.ok(Object.isFrozen(reviewCollision?.rejected))
  assert.equal(resolveSlashSkill('/status', index), null)
  assert.equal(
    resolveSlashSkill(
      '/\u212Aame',
      new SkillIndex([skillRecord(user, 'kame')])
    ),
    null
  )
  assert.equal(
    commandCompletions(index).filter((command) => command.name === 'status')
      .length,
    1
  )

  const loaded = await createSkillTool(index).execute({ name: 'REVIEW' })
  assert.match(loaded.output, /personal instructions/)
  const cli = formatSkillsList(index)
  const tui = stripAnsi(formatSkillsStatus(index))
  for (const output of [cli, tui])
  {
    assert.match(output, /Review/)
    assert.match(output, /review/)
    assert.match(output, /REVIEW/)
    assert.match(output, /rejected collision/i)
  }
})

test('standing instructions and the skill catalog keep separate prompt budgets', async () =>
{
  const cwd = await tempDir('coral-skill-prompt-')
  const record = skillRecord(cwd)
  const skills = new SkillIndex([record])
  const catalog = new ToolCatalog({ trustedTools: [createSkillTool(skills)] })
  const longInstructions = 'user-rule\n'.repeat(900)
  const shortInstructions = 'always preserve user work'
  const prompt = (userInstructions: string, includeSkills: boolean) =>
    buildSystemPrompt({
      model: 'test-model',
      cwd,
      catalog,
      userInstructions,
      skills: includeSkills ? skills : undefined,
    })
  const supplemental = (value: string): string =>
    value.slice(
      value.indexOf('\n\n## User instructions'),
      value.indexOf('\n\n## Project Context')
    )
  const userSection = (value: string): string =>
    supplemental(value).split('\n\n## Skills')[0]!
  const skillsSection = (value: string): string =>
    supplemental(value).slice(supplemental(value).indexOf('\n\n## Skills'))

  const longWithoutSkills = prompt(longInstructions, false)
  const longWithSkills = prompt(longInstructions, true)
  assert.equal(userSection(longWithSkills), userSection(longWithoutSkills))
  assert.equal(
    Buffer.byteLength(userSection(longWithSkills), 'utf-8'),
    USER_INSTRUCTIONS_MAX_BYTES
  )
  assert.match(longWithSkills, /## Skills/)
  assert.ok(
    Buffer.byteLength(skillsSection(longWithSkills), 'utf-8') <=
      SKILL_CATALOG_MAX_BYTES
  )

  const shortWithoutSkills = prompt(shortInstructions, false)
  const shortWithSkills = prompt(shortInstructions, true)
  assert.equal(userSection(shortWithSkills), userSection(shortWithoutSkills))
  assert.equal(skillsSection(shortWithSkills), skillsSection(longWithSkills))
})

test('slash invocation sends semantic content while preserving typed display text through sessions', async () =>
{
  const cwd = await tempDir('coral-skill-display-')
  const packageRoot = join(cwd, 'review-skill')
  await writeSkill(packageRoot, 'Review', 'Review the requested change.')
  const skills = new SkillIndex([skillRecord(packageRoot)])
  const typed = '/rEvIeW inspect src/agent/agent.ts'
  const resolution = requireSkillResolution(resolveSlashSkill(typed, skills))
  let requestMessages: OllamaMessage[] = []
  const { agent } = makeFakeAgent(
    cwd,
    async function* (request)
    {
      requestMessages = request?.messages ?? []
      yield { message: { role: 'assistant', content: 'done' }, done: true }
    },
    { skills }
  )

  await agent.run(
    { content: resolution.prompt, displayContent: typed },
    makeAgentEvents()
  )

  const requestUser = requestMessages.find((message) => message.role === 'user')
  assert.equal(requestUser?.content, resolution.prompt)
  assert.equal(requestUser?.displayContent, undefined)
  assert.equal(agent.getMessages()[1]?.displayContent, typed)
  assert.equal(buildRestoredBlocks(agent.getMessages())[0]?.content, typed)

  process.env.CORAL_HOME = await tempDir('coral-skill-session-')
  const meta = createSession('test-model', cwd, agent.getMessages())
  const restored = loadSession(meta.id)
  assert.equal(meta.title, typed)
  assert.equal(restored?.messages[1]?.displayContent, typed)
  await agent.dispose()
})

test('pruning keeps every active-turn skill result and only the newest completed skill result', () =>
{
  const state = new ConversationState('system')
  state.appendMessages([
    { role: 'user', content: 'old turn' },
    { role: 'tool', tool_name: 'skill', content: 'old skill result' },
    { role: 'user', content: 'latest completed turn' },
    {
      role: 'tool',
      tool_name: 'skill',
      content: 'latest completed skill result',
    },
  ])
  const anchor = state.acceptUserMessage('active turn')
  state.appendMessages([
    { role: 'tool', tool_name: 'skill', content: 'active skill one' },
    { role: 'tool', tool_name: 'grep', content: 'ordinary active result' },
    { role: 'tool', tool_name: 'skill', content: 'active skill two' },
  ])

  const activeTransition = state.pruneToolResults('2026-08-16T00:00:00.000Z', 0)
  const activeMessages = state.getMessages()
  assert.equal(activeTransition?.prunedResults, 3)
  assert.match(activeMessages[2]!.content, /^\[tool result pruned/)
  assert.match(activeMessages[4]!.content, /^\[tool result pruned/)
  assert.equal(activeMessages[6]!.content, 'active skill one')
  assert.match(activeMessages[7]!.content, /^\[tool result pruned/)
  assert.equal(activeMessages[8]!.content, 'active skill two')

  assert.equal(state.finalizeActiveTurn(anchor).recorded, true)
  const completedTransition = state.pruneToolResults(
    '2026-08-16T00:01:00.000Z',
    0
  )
  const completedMessages = state.getMessages()
  assert.equal(completedTransition?.prunedResults, 1)
  assert.match(completedMessages[4]!.content, /^\[tool result pruned/)
  assert.match(completedMessages[6]!.content, /^\[tool result pruned/)
  assert.equal(completedMessages[8]!.content, 'active skill two')
})
