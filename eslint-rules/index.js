// rules/index.js
// shared ESLint comment-style rules plugin

import fileHeader from './file-header.js'
import noJsdocBlocks from './no-jsdoc-blocks.js'
import commentStyleGuide from './comment-style-guide.js'

export default {
  rules: {
    'file-header': fileHeader,
    'no-jsdoc-blocks': noJsdocBlocks,
    'comment-style-guide': commentStyleGuide,
  },
}
