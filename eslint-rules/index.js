// eslint-rules/index.js
// shared ESLint comment-style rules plugin

import blockDocComments from './block-doc-comments.js'
import commentTags from './comment-tags.js'
import fileHeader from './file-header.js'
import noUnicodeArrow from './no-unicode-arrow.js'
import plainCommentCase from './plain-comment-case.js'

export default {
  rules: {
    'block-doc-comments': blockDocComments,
    'comment-tags': commentTags,
    'file-header': fileHeader,
    'no-unicode-arrow': noUnicodeArrow,
    'plain-comment-case': plainCommentCase,
  },
}
