// src/tools/grep.ts
// search file contents by regex pattern via ripgrep

import { execFile } from "node:child_process";
import type { Tool, ToolResult } from "./tool.js";

const MAX_RESULTS = 200;
const TIMEOUT = 15_000;

// grep tool
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
      "-n",        // line numbers
      "-H",        // filenames
      "--hidden",  // include hidden files
      "--no-messages", // suppress file-access errors
      "--regexp", pattern,
    ];

    if (include) {
      rgArgs.push("--glob", include);
    }

    rgArgs.push(path);

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

        // exit code 1 = no matches (not an error)
        if (err && (err as { code?: number }).code === 1) {
          resolve({ output: "No matches found." });
          return;
        }

        // exit code 2 = actual error
        if (err && (err as { code?: number }).code === 2) {
          resolve({ output: "", error: stderr || err.message });
          return;
        }

        // other errors (timeout, signal, etc.)
        if (err) {
          resolve({ output: "", error: stderr || err.message });
          return;
        }

        const lines = stdout.split("\n").filter(Boolean);
        const total = lines.length;
        const truncated = total > MAX_RESULTS;
        const shown = truncated ? lines.slice(0, MAX_RESULTS) : lines;

        let output = shown.join("\n");
        if (truncated) {
          output += `\n\n(Showing ${MAX_RESULTS} of ${total} matches — narrow your search for more specific results)`;
        }

        resolve({ output });
      });
    });
  },
};
