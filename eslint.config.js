// eslint.config.js
// configure ESLint for TypeScript, JavaScript, and comment rules
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import prettierConfig from 'eslint-config-prettier'
import localRules from './eslint-rules/index.js'

const languageOptions = {
  ecmaVersion: 'latest',
  globals: globals.node,
}

const commentRules = {
  'ggfincke/file-header': 'error',
  'ggfincke/comment-tags': 'error',
  'ggfincke/plain-comment-case': 'error',
  'ggfincke/block-doc-comments': 'error',
  'ggfincke/no-unicode-arrow': 'error',
  'no-inline-comments': [
    'error',
    {
      ignorePattern: '^\\s*(?:eslint(?:-disable)?|@ts-|istanbul|c8\\b|v8\\b)',
    },
  ],
}

const plugins = {
  ggfincke: localRules,
}

export default defineConfig([
  // exclude build output & reference projects
  globalIgnores(['dist', 'reference']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      prettierConfig,
    ],
    languageOptions,
    plugins,
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended, prettierConfig],
    languageOptions,
    plugins,
  },
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    plugins,
    rules: commentRules,
  },
])
