// src/agent/system-prompt.ts
// system prompt construction w/ model-tier awareness

import type { Tool } from "../tools/tool.js";

type ModelTier = "large" | "small";

// known large models (31B+ param) that benefit from extended prompts
const LARGE_MODEL_PREFIXES = [
  "qwen3-coder-next",
  "devstral",
  "gpt-oss:120b",
  "gemma4",
];

// determine whether a model gets the extended prompt
function getModelTier(model: string): ModelTier {
  return LARGE_MODEL_PREFIXES.some((m) => model.startsWith(m))
    ? "large"
    : "small";
}

// format a single tool into a readable block
function formatTool(tool: Tool): string {
  const params = tool.parameters as {
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  const props = params.properties ?? {};
  const required = new Set(params.required ?? []);

  const paramLines = Object.entries(props).map(([name, schema]) => {
    const req = required.has(name) ? " (required)" : " (optional)";
    const desc = schema.description ? ` — ${schema.description}` : "";
    return `    - ${name}: ${schema.type}${req}${desc}`;
  });

  return `- **${tool.name}**: ${tool.description}\n  Parameters:\n${paramLines.join("\n")}`;
}

// generate the tool block from the registry
function formatTools(tools: Tool[]): string {
  return tools.map(formatTool).join("\n\n");
}

// base prompt — every model gets this
function basePrompt(cwd: string, toolBlock: string): string {
  return `You are Coral, a local coding agent running via Ollama. You help developers by reading code, editing files, running shell commands, & answering questions about codebases.

## Working Directory

You are working in: ${cwd}
All relative paths are resolved from this directory.

## Tools

You have the following tools available:

${toolBlock}

## Rules

- Be concise & direct — show code, not explanations, unless asked
- Read files before editing them — never assume contents
- Use relative paths from the working directory
- When a task is ambiguous, ask for clarification rather than guessing
- Show relevant code snippets when explaining code`;
}

// extended prompt — appended for large models only
function extendedPrompt(): string {
  return `

## Extended Guidance

- Prefer surgical edits over full file rewrites — change only what needs to change
- For multi-step tasks, plan your approach before starting: read relevant files first, understand the context, then make changes
- When editing code, verify your changes by reading the file after writing to confirm correctness
- If a bash command fails, read the error carefully & try to fix the root cause rather than retrying blindly
- When you encounter something unexpected, explain what you found & ask the user how to proceed rather than making assumptions
- If a task requires changes across multiple files, explain the full plan before starting`;
}

// build the complete system prompt for a given model & context
export function buildSystemPrompt(ctx: {
  model: string;
  cwd: string;
  tools: Tool[];
}): string {
  const tier = getModelTier(ctx.model);
  const toolBlock = formatTools(ctx.tools);
  const base = basePrompt(ctx.cwd, toolBlock);
  const extended = tier === "large" ? extendedPrompt() : "";
  return base + extended;
}
