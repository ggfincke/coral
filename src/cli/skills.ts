// src/cli/skills.ts
// list discovered skills and print the shared Agents skills path

import { resolve } from 'node:path'
import type { CliOptions, SkillsCliAction } from './args.js'
import {
  discoverSkills,
  PERSONAL_SKILLS_HINT,
  skillDisplayFields,
} from '../skills/discover.js'
import {
  canonicalSkillName,
  type SkillIndex,
  type SkillRecord,
} from '../skills/types.js'
import { agentsHomePath } from '../utils/agents-home.js'
import { toErrorMessage } from '../utils/errors.js'

interface SkillsCliIo
{
  writeStdout?: (text: string) => void
  writeStderr?: (text: string) => void
}

function formatRecord(record: SkillRecord): string[]
{
  const { name, source, root, description } = skillDisplayFields(record)
  return [`${name}  ${source}  ${root}`, `  ${description}`]
}

export function formatSkillsList(index: SkillIndex): string
{
  if (index.size === 0)
  {
    return `No skills installed. ${PERSONAL_SKILLS_HINT}\n`
  }

  const lines: string[] = []
  const collisions = new Map(
    index.collisions.map((collision) => [collision.canonicalName, collision])
  )
  for (const record of index.records)
  {
    lines.push(...formatRecord(record))
    const collision = collisions.get(canonicalSkillName(record.name))
    for (const rejected of collision?.rejected ?? [])
    {
      const { name, source, root } = skillDisplayFields(rejected)
      lines.push(`  rejected collision: ${name}  ${source}  ${root}`)
    }
  }
  return `${lines.join('\n')}\n`
}

// skills subcommands share -C with the other entry paths
export function runSkillsCli(
  action: SkillsCliAction,
  options: Pick<CliOptions, 'cwd'>,
  io: SkillsCliIo = {}
): number
{
  const writeStdout = io.writeStdout ?? ((text) => process.stdout.write(text))
  const writeStderr = io.writeStderr ?? ((text) => process.stderr.write(text))
  try
  {
    if (action === 'path')
    {
      writeStdout(`${agentsHomePath('skills')}\n`)
      return 0
    }
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    writeStdout(
      formatSkillsList(discoverSkills({ cwd, agentsHome: agentsHomePath() }))
    )
    return 0
  }
  catch (error)
  {
    writeStderr(`${toErrorMessage(error)}\n`)
    return 1
  }
}
