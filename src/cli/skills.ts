// src/cli/skills.ts
// list discovered skills and print the shared Agents skills path

import { Command, CommanderError } from 'commander'
import { discoverSkills, PERSONAL_SKILLS_HINT } from '../skills/discover.js'
import { agentsHomePath } from '../utils/agents-home.js'
import { excerpt } from '../utils/ellipsize.js'
import { toErrorMessage } from '../utils/errors.js'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'

export const SKILLS_SEED_HINT = `Coral does not copy skills into CORAL_HOME. ${PERSONAL_SKILLS_HINT}`
const SKILL_NAME_MAX = 128
const SKILL_SOURCE_MAX = 32
const SKILL_ROOT_MAX = 240
const SKILL_DESCRIPTION_MAX = 240

// optional writers so tests do not patch process.stdout
interface SkillsCliIo
{
  writeStdout?: (text: string) => void
  writeStderr?: (text: string) => void
}

function displayField(value: string, max: number): string
{
  return excerpt(sanitizeUntrustedText(value).replace(/\s+/g, ' ').trim(), max)
}

function printList(
  cwd: string,
  agentsHome: string,
  writeStdout: (text: string) => void
): void
{
  const index = discoverSkills({ cwd, agentsHome })
  if (index.size === 0)
  {
    writeStdout(`No skills installed. ${PERSONAL_SKILLS_HINT}\n`)
    return
  }

  for (const record of index.records)
  {
    const name = displayField(record.name, SKILL_NAME_MAX)
    const source = displayField(record.source, SKILL_SOURCE_MAX)
    const root = displayField(record.root, SKILL_ROOT_MAX)
    const description = displayField(record.description, SKILL_DESCRIPTION_MAX)
    writeStdout(`${name}  ${source}  ${root}\n`)
    writeStdout(`  ${description}\n`)
  }
}

export async function runSkillsCli(
  argv: string[],
  io: SkillsCliIo = {}
): Promise<number>
{
  const writeStdout = io.writeStdout ?? ((text) => process.stdout.write(text))
  const writeStderr = io.writeStderr ?? ((text) => process.stderr.write(text))
  const agentsHome = agentsHomePath()
  const cwd = process.cwd()
  const program = new Command()
    .name('coral skills')
    .description('List and locate Agent skill packages')
    .exitOverride()

  program
    .command('list', { isDefault: true })
    .description('List discovered skills')
    .action(() =>
    {
      printList(cwd, agentsHome, writeStdout)
    })

  program
    .command('seed')
    .description('Skills are not copied into CORAL_HOME; prints how to install')
    .option('--from <dir>', 'ignored; Coral does not copy skills')
    .option('--force', 'ignored; Coral does not copy skills')
    .action(() =>
    {
      throw new Error(SKILLS_SEED_HINT)
    })

  program
    .command('path')
    .description('Print AGENTS_HOME/skills')
    .action(() =>
    {
      writeStdout(`${agentsHomePath('skills')}\n`)
    })

  try
  {
    await program.parseAsync(argv, { from: 'user' })
    return 0
  }
  catch (error)
  {
    if (error instanceof CommanderError)
    {
      return error.exitCode
    }
    writeStderr(`${toErrorMessage(error)}\n`)
    return 1
  }
}
