// src/tools/file-utils.ts
// shared file-read helpers w/ size guards

import type { ToolResult } from './tool.js'
import {
  formatRequiredTextFileError,
  readRequiredTextFile,
} from '../utils/file-read.js'

// success result from readFileGuarded
export interface FileContent
{
  ok: true
  path: string
  content: string
}

// failure result from readFileGuarded
export interface FileError
{
  ok: false
  path: string
  result: ToolResult
}

// read a file w/ size guard to prevent loading huge files into memory
export async function readFileGuarded(
  rawPath: string
): Promise<FileContent | FileError>
{
  const result = await readRequiredTextFile(rawPath)
  if (result.ok) return result
  return {
    ok: false,
    path: result.path,
    result: { output: '', error: formatRequiredTextFileError(result) },
  }
}
