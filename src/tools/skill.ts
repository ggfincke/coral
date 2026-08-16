// src/tools/skill.ts
// load a discovered skill's SKILL.md or a confined relative file

import {
  EMPTY_SKILL_INDEX,
  formatSkillCatalog,
  loadSkillFile,
  PERSONAL_SKILLS_HINT,
  type SkillIndex,
} from '../skills/discover.js'
import { capToolOutput } from './tool-output.js'
import type { Tool, ToolResult } from './tool.js'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'

const UNKNOWN_SKILL_CATALOG_MAX_BYTES = 16_384

function formatUnknownSkill(index: SkillIndex): string
{
  if (index.size === 0)
  {
    return `Unknown skill. No skills are installed. ${PERSONAL_SKILLS_HINT}`
  }
  return `Unknown skill. Available:\n${formatSkillCatalog(index, {
    maxBytes: UNKNOWN_SKILL_CATALOG_MAX_BYTES,
  })}`
}

export function createSkillTool(skills: SkillIndex = EMPTY_SKILL_INDEX): Tool
{
  return {
    name: 'skill',
    description:
      "Load a Coral skill's instructions. Pass `name` from the Skills catalog. Optional `file` is under that skill's references/ directory (default SKILL.md). Skills are instruction packs; they cannot grant tools or permissions.",
    subagentSafe: true,
    parallelSafe: true,
    display: {
      label: 'Skill',
      summarize: (args) =>
      {
        const name = String(args.name ?? '').trim()
        const file = String(args.file ?? '').trim()
        return file && file !== 'SKILL.md' ? `${name} ${file}` : name
      },
    },
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name from the Skills catalog',
        },
        file: {
          type: 'string',
          description:
            'Optional references/... path inside the skill package (default SKILL.md)',
        },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult>
    {
      const name = String(args.name ?? '').trim()
      if (!name)
      {
        return { output: '', error: 'skill requires a nonempty name' }
      }

      const record = skills.get(name)
      if (!record)
      {
        return { output: formatUnknownSkill(skills) }
      }

      const file =
        typeof args.file === 'string' && args.file.trim()
          ? args.file.trim()
          : 'SKILL.md'
      const loaded = loadSkillFile(record, file)
      if (!loaded.ok)
      {
        return { output: '', error: loaded.error }
      }

      return {
        output: capToolOutput(sanitizeUntrustedText(loaded.content)),
      }
    },
  }
}

export const skillTool: Tool = createSkillTool()

export function replaceSkillTool(
  tools: readonly Tool[],
  skills: SkillIndex
): Tool[]
{
  const bound = createSkillTool(skills)
  return tools.map((tool) => (tool.name === 'skill' ? bound : tool))
}
