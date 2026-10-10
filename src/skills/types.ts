// src/skills/types.ts
// skill identity, precedence, and immutable discovery results

export type SkillSource = 'user' | 'project-agents' | 'project-coral'

/** One discovered skill package with a resolved package root. */
export interface SkillRecord
{
  readonly name: string
  readonly description: string
  readonly source: SkillSource
  readonly root: string
}

/** One case-folded name collision and every package displaced by its winner. */
export interface SkillCollision
{
  readonly canonicalName: string
  readonly winner: SkillRecord
  readonly rejected: readonly SkillRecord[]
}

// skill names are ASCII by contract, so identity does not depend on locale
export function canonicalSkillName(name: string): string
{
  return name.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

export function compareSkillText(left: string, right: string): number
{
  return left < right ? -1 : left > right ? 1 : 0
}

function freezeRecord(record: SkillRecord): SkillRecord
{
  return Object.freeze({ ...record })
}

/** Name-keyed winners plus immutable diagnostics for rejected packages. */
export class SkillIndex
{
  readonly records: readonly SkillRecord[]
  readonly collisions: readonly SkillCollision[]
  private readonly byName: ReadonlyMap<string, SkillRecord>

  constructor(
    records: readonly SkillRecord[] = [],
    collisions: readonly SkillCollision[] = []
  )
  {
    this.records = Object.freeze(records.map(freezeRecord))
    const frozenByName = new Map(
      this.records.map((record) => [canonicalSkillName(record.name), record])
    )
    this.byName = frozenByName
    this.collisions = Object.freeze(
      collisions.map((collision) =>
      {
        const winner =
          frozenByName.get(collision.canonicalName) ??
          freezeRecord(collision.winner)
        return Object.freeze({
          canonicalName: collision.canonicalName,
          winner,
          rejected: Object.freeze(collision.rejected.map(freezeRecord)),
        })
      })
    )
  }

  get size(): number
  {
    return this.records.length
  }

  get(name: string): SkillRecord | undefined
  {
    return this.byName.get(canonicalSkillName(name))
  }
}

export const EMPTY_SKILL_INDEX = new SkillIndex()
