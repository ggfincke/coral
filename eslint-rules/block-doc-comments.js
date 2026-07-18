// eslint-rules/block-doc-comments.js
// validate sentence-style block docs on classes, interfaces, & enums

import { getFilename, getSourceCode } from './ruleContext.js'

const LARGE_UNIT_TYPES = new Set([
  'ClassDeclaration',
  'ClassExpression',
  'TSInterfaceDeclaration',
  'TSEnumDeclaration',
])

const TOOL_DIRECTIVE = /^(?:eslint|@ts-|istanbul|c8\b|v8\b)/i

const isTestFile = (filename) =>
  /(?:^|\/)(?:tests?|e2e)\//.test(filename) ||
  /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(filename)

const documentedDeclaration = (node) =>
{
  if (!node)
  {
    return undefined
  }
  if (
    node.type === 'ExportDefaultDeclaration' ||
    node.type === 'ExportNamedDeclaration'
  )
  {
    return node.declaration ?? undefined
  }
  return node
}

const isJsxComment = (comment, sourceCode) =>
{
  const before = sourceCode.text.slice(0, comment.range[0]).trimEnd()
  const after = sourceCode.text.slice(comment.range[1]).trimStart()
  return before.endsWith('{') && after.startsWith('}')
}

const summaryParagraph = (comment) =>
{
  const lines = comment.value
    .replace(/^\*/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, '').trim())
  const paragraph = []
  for (const line of lines)
  {
    if (!line)
    {
      if (paragraph.length > 0)
      {
        break
      }
      continue
    }
    if (line.startsWith('@'))
    {
      break
    }
    paragraph.push(line)
  }
  return paragraph.join(' ')
}

const startsLikeSentence = (summary) =>
  /^[A-Z0-9]/.test(summary) ||
  ['`', "'", '"', '(', '['].includes(summary[0]) ||
  /^[a-z][A-Z]/.test(summary)

const endsWithPeriod = (summary) => /\.(?:[`'"\])}]*)$/.test(summary)

const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Allow sentence-style block docs only on classes, interfaces, and enums',
      category: 'Stylistic Issues',
    },
    schema: [],
    messages: {
      blockComment:
        'Use line comments for implementation rationale; block comments are reserved for class, interface, and enum documentation',
      disallowedDocumentation:
        'TSDoc/JSDoc belongs on classes, interfaces, and enums; use a plain comment above ordinary functions',
      detachedDocumentation:
        'Attach TSDoc/JSDoc directly to the class, interface, or enum it documents',
      missingSummary: 'Block documentation needs a summary sentence',
      summaryCapitalization:
        'Block documentation summary must begin with a capitalized sentence',
      summaryPeriod: 'Block documentation summary must end with a period',
      testDocumentation:
        'Tests and test helpers do not use block documentation; use a plain why-comment if needed',
    },
  },

  create(context)
  {
    const sourceCode = getSourceCode(context)
    const filename = getFilename(context).replace(/\\/g, '/')

    return {
      Program()
      {
        for (const comment of sourceCode.getAllComments())
        {
          if (comment.type !== 'Block' || isJsxComment(comment, sourceCode))
          {
            continue
          }
          const isDocumentation = comment.value.startsWith('*')
          if (!isDocumentation)
          {
            if (!TOOL_DIRECTIVE.test(comment.value.trim()))
            {
              context.report({ node: comment, messageId: 'blockComment' })
            }
            continue
          }
          if (isTestFile(filename))
          {
            context.report({ node: comment, messageId: 'testDocumentation' })
            continue
          }

          const token = sourceCode.getTokenAfter(comment, {
            includeComments: false,
          })
          if (!token)
          {
            context.report({
              node: comment,
              messageId: 'detachedDocumentation',
            })
            continue
          }
          const gap = sourceCode.text.slice(comment.range[1], token.range[0])
          if (!/^\s*$/.test(gap) || (gap.match(/\n/g)?.length ?? 0) > 1)
          {
            context.report({
              node: comment,
              messageId: 'detachedDocumentation',
            })
            continue
          }

          const nextNode = sourceCode.getNodeByRangeIndex(token.range[0])
          const target = documentedDeclaration(nextNode)
          if (!target || !LARGE_UNIT_TYPES.has(target.type))
          {
            context.report({
              node: comment,
              messageId: 'disallowedDocumentation',
            })
            continue
          }

          const summary = summaryParagraph(comment)
          if (!summary)
          {
            context.report({ node: comment, messageId: 'missingSummary' })
          }
          else
          {
            if (!startsLikeSentence(summary))
            {
              context.report({
                node: comment,
                messageId: 'summaryCapitalization',
              })
            }
            if (!endsWithPeriod(summary))
            {
              context.report({ node: comment, messageId: 'summaryPeriod' })
            }
          }
        }
      },
    }
  },
}

export default rule
