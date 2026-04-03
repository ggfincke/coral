// src/tools/glob.ts
// find files by name pattern via ripgrep

import type { Tool, ToolResult } from "./tool.js";
import { execRipgrep, truncateOutput } from "./ripgrep-utils.js";

const MAX_FILES = 100;

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

    const result = await execRipgrep(rgArgs, "No matching files found.");
    if (result.error || result.output === "No matching files found.") return result;

    return { output: truncateOutput(result.output, MAX_FILES, "files") };
  },
};
