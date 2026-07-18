// eslint-rules/ruleContext.js
// share ESLint context accessors & comment fixers

export const getSourceCode = (context) =>
  context.sourceCode ?? context.getSourceCode()

export const getAllComments = (context) =>
  getSourceCode(context).getAllComments()

export const getFilename = (context) =>
  context.filename ?? context.getFilename()

export const getCwd = (context) => context.cwd ?? process.cwd()

export const wrapCommentText = (comment, text) =>
  comment.type === 'Line' ? `//${text}` : `/*${text}*/`
