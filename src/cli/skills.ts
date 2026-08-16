// src/cli/skills.ts
// list discovered skills and print the shared Agents skills path

import { resolve } from 'node:path'
import type { CliOptions, SkillsCliAction } from './args.js'
import { discoverSkills, PERSONAL_SKILLS_HINT } from '../skills/discover.js'
import {
  canonicalSkillName,
  type SkillIndex,
  type SkillRecord,
} from '../skills/types.js'
import { agentsHomePath } from '../utils/agents-home.js'
import { excerpt } from '../utils/ellipsize.js'
import { toErrorMessage } from '../utils/errors.js'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'

const SKILL_NAME_MAX = 128
const SKILL_SOURCE_MAX = 32
const SKILL_ROOT_MAX = 240
const SKILL_DESCRIPTION_MAX = 240

interface SkillsCliIo
{
  writeStdout?: (text: string) => void
  writeStderr?: (text: string) => void
}

function displayField(value: string, max: number): string
{
  return excerpt(sanitizeUntrustedText(value).replace(/\s+/g, ' ').trim(), max)
}

function formatRecord(record: SkillRecord): string[]
{
  const name = displayField(record.name, SKILL_NAME_MAX)
  const source = displayField(record.source, SKILL_SOURCE_MAX)
  const root = displayField(record.root, SKILL_ROOT_MAX)
  const description = displayField(record.description, SKILL_DESCRIPTION_MAX)
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
      const name = displayField(rejected.name, SKILL_NAME_MAX)
      const source = displayField(rejected.source, SKILL_SOURCE_MAX)
      const root = displayField(rejected.root, SKILL_ROOT_MAX)
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
