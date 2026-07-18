// eslint-rules/file-header.js
// validate exact two-line repo-relative file headers

import { isAbsolute, relative } from 'node:path'

import { getCwd, getFilename, getSourceCode } from './ruleContext.js'

const normalizePath = (value) => value.replace(/\\/g, '/')

const resolveRelativePath = (filename, cwd) =>
  normalizePath(isAbsolute(filename) ? relative(cwd, filename) : filename)

const descriptionText = (comment) => comment.value.trim()

const isTaggedDescription = (description) =>
  /^(?:[*!?](?:\s|$)|todo(?:\([^)]*\))?:?\s)/i.test(description)

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
      descriptionNotLowercase:
        'File header description must begin with a lowercase letter or number',
      descriptionPeriod: 'File header description must not end with a period',
      taggedDescription:
        'File header descriptions must be plain purpose phrases, not tagged annotations',
      thirdHeaderLine:
        'File headers must contain exactly two consecutive comment lines',
    },
  },

  create(context)
  {
    const sourceCode = getSourceCode(context)
    const filename = getFilename(context)
    const cwd = getCwd(context)

    return {
      Program(node)
      {
        const comments = sourceCode.getAllComments()
        const firstComment = comments[0]
        const hasShebang = firstComment?.type === 'Shebang'
        const headerIndex = hasShebang ? 1 : 0
        const headerLine = hasShebang ? 2 : 1
        const descriptionLine = headerLine + 1
        const headerComment = comments[headerIndex]

        const relativePath = resolveRelativePath(filename, cwd)

        // require the path comment to be the first source line
        if (
          !headerComment ||
          headerComment.loc.start.line !== headerLine ||
          headerComment.type !== 'Line'
        )
        {
          context.report({ node, messageId: 'missingHeader' })
          return
        }

        // keep the header path tied to the cwd-relative filename
        const headerPath = headerComment.value.trim()
        if (headerPath !== relativePath)
        {
          context.report({
            node: headerComment,
            messageId: 'invalidPath',
            data: { expected: relativePath },
            fix(fixer)
            {
              return fixer.replaceText(headerComment, `// ${relativePath}`)
            },
          })
        }

        const secondComment = comments[headerIndex + 1]
        if (
          !secondComment ||
          secondComment.loc.start.line !== descriptionLine ||
          secondComment.type !== 'Line' ||
          secondComment.value.trim() === ''
        )
        {
          context.report({
            loc: { line: descriptionLine, column: 0 },
            messageId: 'missingDescription',
          })
          return
        }

        const description = descriptionText(secondComment)
        if (!/^[a-z0-9]/.test(description))
        {
          const fix = /^[A-Z]/.test(description)
            ? (fixer) =>
                fixer.replaceText(
                  secondComment,
                  `// ${description[0].toLowerCase()}${description.slice(1)}`
                )
            : undefined
          context.report({
            node: secondComment,
            messageId: 'descriptionNotLowercase',
            fix,
          })
        }
        if (description.endsWith('.'))
        {
          context.report({
            node: secondComment,
            messageId: 'descriptionPeriod',
            fix(fixer)
            {
              return fixer.replaceText(
                secondComment,
                `// ${description.slice(0, -1)}`
              )
            },
          })
        }
        if (isTaggedDescription(description))
        {
          context.report({
            node: secondComment,
            messageId: 'taggedDescription',
          })
        }

        const thirdComment = comments[headerIndex + 2]
        if (
          thirdComment?.type === 'Line' &&
          thirdComment.loc.start.line === descriptionLine + 1
        )
        {
          context.report({
            node: thirdComment,
            messageId: 'thirdHeaderLine',
            fix(fixer)
            {
              return fixer.insertTextBefore(thirdComment, '\n')
            },
          })
        }
      },
    }
  },
}

export default rule
