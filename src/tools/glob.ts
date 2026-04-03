// src/tools/glob.ts
// find files by name pattern via ripgrep

import { execFile } from "node:child_process";
import type { Tool, ToolResult } from "./tool.js";

const MAX_FILES = 100;
const TIMEOUT = 15_000;

// glob tool
export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by name/path glob pattern. Returns matching file paths sorted by modification time (newest first). Requires ripgrep (rg) to be installed.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match files (e.g., '**/*.ts', 'src/**/test*')",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: working directory)",
      },
    },
    required: ["pattern"],
  },
  async execute(args): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const path = (args.path as string) ?? ".";

    const rgArgs = [
      "--files",
      "--hidden",
      "--sort=modified",
      "--glob", pattern,
      path,
    ];

    return new Promise((resolve) => {
      execFile("rg", rgArgs, { timeout: TIMEOUT, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        // rg not found
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({
            output: "",
            error: "ripgrep (rg) is not installed. Install it: https://github.com/BurntSushi/ripgrep#installation",
          });
          return;
        }

        // exit code 1 = no matches
        if (err && (err as { code?: number }).code === 1) {
          resolve({ output: "No matching files found." });
          return;
        }

        // other errors
        if (err) {
          resolve({ output: "", error: stderr || err.message });
          return;
        }

        const files = stdout.split("\n").filter(Boolean);
        const total = files.length;
        const truncated = total > MAX_FILES;
        const shown = truncated ? files.slice(0, MAX_FILES) : files;

        let output = shown.join("\n");
        if (truncated) {
          output += `\n\n(Showing ${MAX_FILES} of ${total} files — use a more specific pattern to narrow results)`;
        }

        resolve({ output });
      });
    });
  },
};
