// src/tools/read.ts
// read file contents from disk

import type { Tool, ToolResult } from "./tool.js";
import { readFileGuarded } from "./file-utils.js";

export const readTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file at the given path.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path" },
    },
    required: ["path"],
  },
  async execute(args): Promise<ToolResult> {
    const path = args.path as string;
    const result = await readFileGuarded(path);
    if (!result.ok) return result.result;
    return { output: result.content };
  },
};
