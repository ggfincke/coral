// eslint-rules/no-jsdoc-blocks.js
// prohibit JSDoc blocks

const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow JSDoc block comments in favor of single-line comments',
      category: 'Stylistic Issues',
    },
    fixable: null,
    schema: [],
    messages: {
      noJsDoc:
        'JSDoc blocks are not allowed. Use single-line comments (//) instead. TypeScript types provide documentation.',
    },
  },

  create(context)
  {
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    return {
      Program()
      {
        const comments = sourceCode.getAllComments()

        for (const comment of comments)
        {
          // check JSDoc block shape
          if (comment.type === 'Block' && comment.value.startsWith('*'))
          {
            context.report({
              loc: comment.loc,
              messageId: 'noJsDoc',
            })
          }
        }
      },
    }
  },
}

export default rule
