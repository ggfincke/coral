// eslint-rules/plain-comment-case.js
// require lowercase starts for plain natural-language comments

import { getAllComments } from './ruleContext.js'

const TOOL_DIRECTIVE = /^(?:eslint|@ts-|istanbul|c8\b|v8\b)/i
const STRUCTURED_PREFIX = /^(?:[*!?]\s|TODO(?:\([^)]*\):)?\s)/

const isCodeLikeToken = (token) =>
  token === 'No.' || /[A-Z]/.test(token.slice(1)) || /[._\d]/.test(token)

const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require lowercase starts for plain comments',
      category: 'Stylistic Issues',
    },
    fixable: 'code',
    schema: [],
    messages: {
      uppercaseComment:
        'Plain comments start lowercase; preserve uppercase only for exact code symbols',
    },
  },

  create(context)
  {
    return {
      Program()
      {
        for (const comment of getAllComments(context))
        {
          if (comment.type !== 'Line' || comment.loc.start.line <= 2)
          {
            continue
          }
          const text = comment.value.trim()
          if (
            TOOL_DIRECTIVE.test(text) ||
            STRUCTURED_PREFIX.test(text) ||
            text.startsWith('===')
          )
          {
            continue
          }
          const token = text.match(/^([A-Z][^\s]*)/)?.[1]
          if (!token || isCodeLikeToken(token))
          {
            continue
          }
          context.report({
            node: comment,
            messageId: 'uppercaseComment',
            fix(fixer)
            {
              return fixer.replaceText(
                comment,
                `// ${text[0].toLowerCase()}${text.slice(1)}`
              )
            },
          })
        }
      },
    }
  },
}

export default rule
