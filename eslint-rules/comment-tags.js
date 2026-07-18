// eslint-rules/comment-tags.js
// validate canonical structured comment-tag syntax

import { getAllComments } from './ruleContext.js'

const TODO_PREFIX = /^todo\b/i
const VALID_TODO = /^TODO(?:\([a-z0-9][a-z0-9._/-]*\):)?\s+\S/
const LEGACY_TAG = /^(?:FOOTGUN|HACK|NOTE|WARN(?:ING)?|FIXME|XXX):\s*/i

const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce canonical Better Comments and TODO tags',
      category: 'Stylistic Issues',
    },
    schema: [],
    messages: {
      invalidTag: 'Use `{{ tag }} ` followed by a short annotation',
      invalidTodo:
        'Use `TODO action` or `TODO(scope): action` with an uppercase TODO and lowercase scope',
      legacyTag:
        'Use a canonical `*`, `!`, `?`, or `TODO` annotation instead of `{{ tag }}`',
    },
  },

  create(context)
  {
    return {
      Program()
      {
        for (const comment of getAllComments(context))
        {
          if (comment.type !== 'Line')
          {
            continue
          }
          const text = comment.value.trim()
          const legacyTag = text.match(LEGACY_TAG)?.[0]
          if (legacyTag)
          {
            context.report({
              node: comment,
              messageId: 'legacyTag',
              data: { tag: legacyTag },
            })
            continue
          }
          if (TODO_PREFIX.test(text) && !VALID_TODO.test(text))
          {
            context.report({
              node: comment,
              messageId: 'invalidTodo',
            })
            continue
          }
          const tag = text[0]
          if (
            ['*', '!', '?'].includes(tag) &&
            !new RegExp(`^\\${tag} \\S`).test(text)
          )
          {
            context.report({
              node: comment,
              messageId: 'invalidTag',
              data: { tag },
            })
          }
        }
      },
    }
  },
}

export default rule
