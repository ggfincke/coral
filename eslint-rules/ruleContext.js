// eslint-rules/ruleContext.js
// share ESLint context accessors & comment fixers

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const getSourceCode = (context) =>
  context.sourceCode ?? context.getSourceCode()

export const getAllComments = (context) =>
  getSourceCode(context).getAllComments()

export const getFilename = (context) =>
  context.filename ?? context.getFilename()

// the repo root holds eslint.config.js & this plugin; process cwd may be a subdirectory
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const wrapCommentText = (comment, text) =>
  comment.type === 'Line' ? `//${text}` : `/*${text}*/`
