// src/tools/grep.ts
// search file contents by regex pattern via ripgrep

import type { Tool, ToolResult } from "./tool.js";
import { execRipgrep, truncateOutput } from "./ripgrep-utils.js";

const MAX_RESULTS = 200;

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents by regex pattern. Returns matching lines w/ file paths & line numbers. Requires ripgrep (rg) to be installed.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: {
        type: "string",
        description: "Directory to search in (default: working directory)",
      },
      include: {
        type: "string",
        description: "Glob pattern to filter files (e.g., '*.ts', '*.{js,jsx}')",
      },
    },
    required: ["pattern"],
  },
  async execute(args): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const path = (args.path as string) ?? ".";
    const include = args.include as string | undefined;

    const rgArgs = [
      "-n",
      "-H",
      "--hidden",
      "--no-messages",
      "--regexp", pattern,
    ];

    if (include) {
      rgArgs.push("--glob", include);
    }

    rgArgs.push(path);

    const result = await execRipgrep(rgArgs, "No matches found.");
    if (result.error || result.output === "No matches found.") return result;

    return { output: truncateOutput(result.output, MAX_RESULTS, "matches") };
  },
};
