// src/tools/read.ts
// read file contents from disk

import { readFile } from "node:fs/promises";
import type { Tool, ToolResult } from "./tool.js";

// read_file tool
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
    try {
      const content = await readFile(path, "utf-8");
      return { output: content };
    } catch (err) {
      return { output: "", error: `Failed to read ${path}: ${err}` };
    }
  },
};
