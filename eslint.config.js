// eslint.config.js
// ESLint flat config for TS/JS & comment rules
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import prettierConfig from 'eslint-config-prettier'
import localRules from './eslint-rules/index.js'

const languageOptions = {
  ecmaVersion: 2020,
  globals: globals.node,
}

const commentRules = {
  'ggfincke/no-jsdoc-blocks': 'error',
  'ggfincke/file-header': 'error',
  'ggfincke/comment-style-guide': 'warn',
  'no-inline-comments': 'error',
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
    rules: commentRules,
  },
  {
    files: ['eslint.config.js', 'eslint-rules/*.js', 'scripts/**/*.mjs'],
    extends: [js.configs.recommended, prettierConfig],
    languageOptions,
    plugins,
    rules: commentRules,
  },
])
