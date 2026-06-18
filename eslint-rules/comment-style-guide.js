// eslint-rules/comment-style-guide.js
// enforce comment abbrevs

const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce comment style abbreviations (& for and, w/ for with)',
      category: 'Stylistic Issues',
    },
    fixable: 'code',
    schema: [],
    messages: {
      useAmpersand: 'Use "&" instead of "and" in comments',
      useWith: 'Use "w/" instead of "with" in comments',
    },
  },

  create(context)
  {
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    // match standalone words
    const andTestPattern = /\band\b/i
    const andReplacePattern = /\band\b/gi
    const withTestPattern = /\bwith\b/i
    const withReplacePattern = /\bwith\b/gi

    return {
      Program()
      {
        const comments = sourceCode.getAllComments()

        for (const comment of comments)
        {
          const text = comment.value

          // check ampersand abbrev
          if (andTestPattern.test(text))
          {
            context.report({
              loc: comment.loc,
              messageId: 'useAmpersand',
              fix(fixer)
              {
                const newText = text.replaceAll(andReplacePattern, '&')
                if (comment.type === 'Line')
                {
                  return fixer.replaceText(comment, `//${newText}`)
                }
                else
                {
                  return fixer.replaceText(comment, `/*${newText}*/`)
                }
              },
            })
          }

          // check w/ abbrev
          if (withTestPattern.test(text))
          {
            context.report({
              loc: comment.loc,
              messageId: 'useWith',
              fix(fixer)
              {
                const newText = text.replaceAll(withReplacePattern, 'w/')
                if (comment.type === 'Line')
                {
                  return fixer.replaceText(comment, `//${newText}`)
                }
                else
                {
                  return fixer.replaceText(comment, `/*${newText}*/`)
                }
              },
            })
          }
        }
      },
    }
  },
}

export default rule
