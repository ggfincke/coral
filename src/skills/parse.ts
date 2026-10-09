// src/skills/parse.ts
// skill markdown frontmatter

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/
const FRONTMATTER_CLOSE = /\r?\n---[ \t]*(?:\r?\n|$)/
const BLOCK_SCALAR = /^([>|])[+-]?$/

export interface SkillFrontmatter
{
  name: string
  description: string
}

function unquote(value: string): string
{
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
  {
    return trimmed.slice(1, -1).replace(/\\(["'\\])/g, '$1')
  }
  return trimmed
}

// parse name + description from YAML-like frontmatter; other keys are ignored
export function parseSkillFrontmatter(text: string): SkillFrontmatter | null
{
  const body = text.replace(/^\uFEFF/, '')
  const open = body.match(FRONTMATTER_OPEN)
  if (!open || open.index !== 0) return null

  const rest = body.slice(open[0].length)
  const close = rest.match(FRONTMATTER_CLOSE)
  if (!close || close.index === undefined) return null

  const raw = rest.slice(0, close.index)
  const lines = raw.split(/\r?\n/)
  let name = ''
  let description = ''
  for (let index = 0; index < lines.length; index++)
  {
    const match = lines[index]!.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    let value = unquote(match[2] ?? '')
    // `>` & `|` block scalars take the following indented lines; folded
    // blocks join w/ spaces, literal blocks keep their line breaks
    const block = (match[2] ?? '').trim().match(BLOCK_SCALAR)
    if (block)
    {
      const body: string[] = []
      while (
        index + 1 < lines.length &&
        (/^\s/.test(lines[index + 1]!) || lines[index + 1]!.trim() === '')
      )
      {
        body.push(lines[++index]!.trim())
      }
      value = body.join(block[1] === '>' ? ' ' : '\n').trim()
    }
    if (key === 'name') name = value
    else if (key === 'description') description = value
  }

  if (!SKILL_NAME_RE.test(name) || name.length > 128) return null
  if (!description) return null
  return { name, description }
}
