// src/tools/bash.ts
// execute shell commands & return output

import { exec } from "node:child_process";
import type { Tool, ToolResult } from "./tool.js";
import { getCwd } from "../cwd.js";

const DEFAULT_TIMEOUT = 30_000;

export const bashTool: Tool = {
  name: "bash",
  description: "Execute a bash command and return its output.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute" },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 30000)",
      },
    },
    required: ["command"],
  },
  async execute(args): Promise<ToolResult> {
    const command = args.command as string;
    const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT;

    return new Promise((resolve) => {
      exec(command, { cwd: getCwd(), timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          resolve({
            output: stdout || "",
            error: stderr || err.message,
          });
        } else {
          resolve({ output: stdout + (stderr ? `\n${stderr}` : "") });
        }
      });
    });
  },
};
