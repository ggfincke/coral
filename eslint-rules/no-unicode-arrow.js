// eslint-rules/no-unicode-arrow.js
// replace Unicode right arrows in comments with ASCII ->

import { getAllComments, wrapCommentText } from './ruleContext.js'

const UNICODE_ARROW = '\u2192'

const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow Unicode right arrows (U+2192) in comments; use ASCII -> instead',
      category: 'Stylistic Issues',
    },
    fixable: 'code',
    schema: [],
    messages: {
      noUnicodeArrow: 'Use ASCII `->` instead of Unicode U+2192 in comments.',
    },
  },

  create(context)
  {
    return {
      Program()
      {
        const comments = getAllComments(context)

        for (const comment of comments)
        {
          if (!comment.value.includes(UNICODE_ARROW)) continue

          context.report({
            loc: comment.loc,
            messageId: 'noUnicodeArrow',
            fix(fixer)
            {
              const replaced = comment.value.split(UNICODE_ARROW).join('->')
              return fixer.replaceText(
                comment,
                wrapCommentText(comment, replaced)
              )
            },
          })
        }
      },
    }
  },
}

export default rule
