// src/tools/write.ts
// write content to a file, creating directories as needed

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "./tool.js";

export const writeTool: Tool = {
  name: "write_file",
  description: "Write content to a file, creating directories as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write to" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  async execute(args): Promise<ToolResult> {
    const path = args.path as string;
    const content = args.content as string;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
      return { output: `Wrote ${content.length} bytes to ${path}` };
    } catch (err) {
      return { output: "", error: `Failed to write ${path}: ${err}` };
    }
  },
};
