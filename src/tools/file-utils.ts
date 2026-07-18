// src/tools/file-utils.ts
// shared file-read helpers with size guards

import type { ToolResult } from './tool.js'
import {
  formatRequiredTextFileError,
  readRequiredTextFile,
  type TextFileReadOptions,
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

// read a file with a size guard to prevent loading huge files into memory
export async function readFileGuarded(
  rawPath: string,
  options: TextFileReadOptions = {}
): Promise<FileContent | FileError>
{
  const result = await readRequiredTextFile(rawPath, options)
  if (result.ok) return result
  return {
    ok: false,
    path: result.path,
    result: { output: '', error: formatRequiredTextFileError(result) },
  }
}
