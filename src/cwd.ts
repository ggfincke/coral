// src/cwd.ts
// module-level CWD state — single source of truth for the working directory

import { resolve, isAbsolute } from "node:path";

// current working directory — initialized to process.cwd(), updated by setCwd()
let cwd = process.cwd();

// get the current working directory
export function getCwd(): string {
  return cwd;
}

// set the working directory (absolute path)
export function setCwd(dir: string): void {
  cwd = resolve(dir);
}

// resolve a path against the working directory
// absolute paths pass through unchanged, relative paths are resolved against CWD
export function resolvePath(p: string): string {
  if (isAbsolute(p)) return p;
  return resolve(cwd, p);
}
