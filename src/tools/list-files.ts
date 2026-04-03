// src/tools/list-files.ts
// list directory contents as an indented tree

import { readdir, stat, lstat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Tool, ToolResult } from "./tool.js";

const MAX_ENTRIES = 200;
const DEFAULT_DEPTH = 2;
const INDENT = "  ";

// directories to always skip
const IGNORED = new Set([
  ".git",
  "node_modules",
  ".next",
  ".cache",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".DS_Store",
]);

// entry collected during traversal
interface Entry {
  name: string;
  depth: number;
  isDir: boolean;
  isSymlink: boolean;
}

// BFS directory traversal w/ depth limiting
async function collectEntries(root: string, maxDepth: number): Promise<{ entries: Entry[]; truncated: boolean }> {
  const entries: Entry[] = [];
  // queue: [dirPath, depth]
  const queue: [string, number][] = [[root, 0]];

  while (queue.length > 0) {
    const [dir, depth] = queue.shift()!;

    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // skip unreadable directories
      continue;
    }

    names.sort();

    for (const name of names) {
      if (IGNORED.has(name)) continue;

      const fullPath = join(dir, name);
      let isDir = false;
      let isSymlink = false;

      try {
        const lstats = await lstat(fullPath);
        isSymlink = lstats.isSymbolicLink();
        // follow symlinks to check if they point to a directory
        const stats = isSymlink ? await stat(fullPath) : lstats;
        isDir = stats.isDirectory();
      } catch {
        // skip entries we can't stat
        continue;
      }

      entries.push({ name, depth, isDir, isSymlink });

      if (entries.length >= MAX_ENTRIES) {
        return { entries, truncated: true };
      }

      // recurse into directories (not symlinks to avoid cycles)
      if (isDir && !isSymlink && depth + 1 < maxDepth) {
        queue.push([fullPath, depth + 1]);
      }
    }
  }

  return { entries, truncated: false };
}

// format entries into an indented tree string
function formatTree(root: string, entries: Entry[], truncated: boolean): string {
  const lines: string[] = [`${root}/`];

  for (const entry of entries) {
    const indent = INDENT.repeat(entry.depth + 1);
    let suffix = "";
    if (entry.isDir) suffix = "/";
    else if (entry.isSymlink) suffix = "@";
    lines.push(`${indent}${entry.name}${suffix}`);
  }

  if (truncated) {
    lines.push(`\n(Showing first ${MAX_ENTRIES} entries — use a smaller depth or more specific path)`);
  }

  return lines.join("\n");
}

// list_files tool
export const listFilesTool: Tool = {
  name: "list_files",
  description:
    "List directory contents as an indented tree. Directories are marked w/ trailing '/'. Skips .git, node_modules, & other common noise directories.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to list (default: working directory)",
      },
      depth: {
        type: "number",
        description: "Max recursion depth (default: 2, max: 5)",
      },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const path = (args.path as string) ?? ".";
    const rawDepth = (args.depth as number) ?? DEFAULT_DEPTH;
    const depth = Math.max(1, Math.min(5, Math.floor(rawDepth)));

    // verify the path is a directory
    try {
      const stats = await stat(path);
      if (!stats.isDirectory()) {
        return { output: "", error: `${path} is not a directory` };
      }
    } catch {
      return { output: "", error: `Cannot access ${path}: no such directory` };
    }

    const { entries, truncated } = await collectEntries(path, depth);

    if (entries.length === 0) {
      return { output: `${path}/ (empty)` };
    }

    return { output: formatTree(path, entries, truncated) };
  },
};
