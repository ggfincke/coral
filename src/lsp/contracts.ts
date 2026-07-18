// src/lsp/contracts.ts
// code-intelligence request and service contracts

import { extname } from 'node:path'

const LANGUAGE_IDS = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'typescriptreact'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascriptreact'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
])

export type CodeIntelOperation =
  'definition' | 'references' | 'hover' | 'diagnostics'

export interface CodeIntelQuery
{
  operation: CodeIntelOperation
  path: string
  line?: number
  character?: number
  signal?: AbortSignal
}

export interface CodeIntelService
{
  query(request: CodeIntelQuery): Promise<string>
  dispose(): Promise<void>
}

export function codeIntelLanguageId(path: string): string | null
{
  return LANGUAGE_IDS.get(extname(path).toLowerCase()) ?? null
}

export function isCodeIntelPath(path: string): boolean
{
  return codeIntelLanguageId(path) !== null
}
