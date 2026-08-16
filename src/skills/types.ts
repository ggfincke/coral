// src/skills/types.ts
// skill package identity and an immutable discovered catalog

export type SkillSource = 'user' | 'project-agents' | 'project-coral'

/**
 * One discovered skill package. `root` is the resolved package directory;
 * relative loads stay confined to it.
 */
export interface SkillRecord
{
  readonly name: string
  readonly description: string
  readonly source: SkillSource
  readonly root: string
}

/**
 * Name-keyed catalog of discovered skills. Later discovery roots overwrite
 * earlier records with the same frontmatter name.
 */
export class SkillIndex
{
  readonly records: readonly SkillRecord[]
  private readonly byName: ReadonlyMap<string, SkillRecord>

  constructor(records: readonly SkillRecord[] = [])
  {
    this.records = Object.freeze(
      records.map((record) => Object.freeze({ ...record }))
    )
    this.byName = new Map(this.records.map((record) => [record.name, record]))
  }

  get size(): number
  {
    return this.records.length
  }

  get(name: string): SkillRecord | undefined
  {
    return this.byName.get(name)
  }
}

export const EMPTY_SKILL_INDEX = new SkillIndex()
