// eslint-rules/file-header.js
// validate repo-relative file headers

import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'

const HEADER_ROOTS = ['src/', 'tests/', 'scripts/', 'eslint-rules/']
const HEADER_FILES = new Set(['eslint.config.js'])

function repoRelativePath(filename)
{
  if (filename.startsWith('<')) return null

  const repoPath = relative(process.cwd(), filename).split(sep).join('/')
  if (!repoPath || repoPath === '..' || repoPath.startsWith('../'))
  {
    return null
  }

  if (HEADER_FILES.has(repoPath)) return repoPath
  if (HEADER_ROOTS.some((root) => repoPath.startsWith(root))) return repoPath
  return null
}

const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce file header comments with path and description',
      category: 'Stylistic Issues',
    },
    fixable: 'code',
    schema: [],
    messages: {
      missingHeader: 'File is missing a header comment with the file path',
      invalidPath:
        'File header path does not match actual file path. Expected: {{ expected }}',
      missingDescription: 'File header is missing a description on line 2',
    },
  },

  create(context)
  {
    const sourceCode = context.sourceCode ?? context.getSourceCode()
    const filename = context.filename ?? context.getFilename()
    let rawSource = ''

    try
    {
      rawSource = readFileSync(filename, 'utf-8')
    }
    catch
    {
      rawSource = ''
    }

    return {
      Program(node)
      {
        if (rawSource.startsWith('#!'))
        {
          return
        }

        const comments = sourceCode.getAllComments()
        const firstComment = comments[0]

        const relativePath = repoRelativePath(filename)
        if (!relativePath) return

        // check line-1 path header
        if (!firstComment || ![1, 2].includes(firstComment.loc.start.line))
        {
          context.report({
            node,
            messageId: 'missingHeader',
          })
          return
        }

        // validate path text
        if (firstComment.type !== 'Line')
        {
          context.report({
            node: firstComment,
            messageId: 'missingHeader',
          })
          return
        }

        const headerPath = firstComment.value.trim()
        if (headerPath !== relativePath)
        {
          context.report({
            node: firstComment,
            messageId: 'invalidPath',
            data: { expected: relativePath },
            fix(fixer)
            {
              return fixer.replaceText(firstComment, `// ${relativePath}`)
            },
          })
        }

        // check line-2 description
        const secondComment = comments[1]
        if (
          !secondComment ||
          secondComment.loc.start.line !== firstComment.loc.start.line + 1 ||
          secondComment.type !== 'Line' ||
          secondComment.value.trim() === ''
        )
        {
          context.report({
            loc: { line: 2, column: 0 },
            messageId: 'missingDescription',
          })
        }
      },
    }
  },
}

export default rule
