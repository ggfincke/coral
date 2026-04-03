// src/tools/file-utils.ts
// shared file-read helpers w/ size guards

import { readFile, stat } from "node:fs/promises";
import type { ToolResult } from "./tool.js";
import { resolvePath } from "../cwd.js";

const MAX_FILE_BYTES = 1_048_576; // 1 MB

// success result from readFileGuarded
export interface FileContent {
  ok: true;
  content: string;
}

// failure result from readFileGuarded
export interface FileError {
  ok: false;
  result: ToolResult;
}

// read a file w/ size guard to prevent loading huge files into memory
export async function readFileGuarded(
  rawPath: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<FileContent | FileError> {
  const path = resolvePath(rawPath);
  let size: number;
  try {
    const stats = await stat(path);
    size = stats.size;
  } catch (err) {
    return { ok: false, result: { output: "", error: `Failed to read ${path}: ${err}` } };
  }

  if (size > maxBytes) {
    const sizeMB = (size / 1_048_576).toFixed(1);
    const maxMB = (maxBytes / 1_048_576).toFixed(1);
    return {
      ok: false,
      result: {
        output: "",
        error: `${path} is ${sizeMB}MB — exceeds ${maxMB}MB limit. Use bash w/ head/tail to read a portion.`,
      },
    };
  }

  try {
    const content = await readFile(path, "utf-8");
    return { ok: true, content };
  } catch (err) {
    return { ok: false, result: { output: "", error: `Failed to read ${path}: ${err}` } };
  }
}
