// src/agent/system-prompt.ts
// system prompt construction

import { readdirSync } from 'node:fs'
import { basename } from 'node:path'
import type { Tool } from '../tools/tool.js'
import { gatherProjectContext } from './context.js'
import { createIgnoredEntrySet } from '../shared/ignored-entries.js'

const PROJECT_CONTEXT_LIMIT = 12

// root entries that add noise instead of context
const IGNORED_ROOT_ENTRIES = createIgnoredEntrySet()

// format a single tool into a readable block
function formatTool(tool: Tool): string
{
  const { properties, required = [] } = tool.parameters
  const requiredSet = new Set(required)

  const paramLines = Object.entries(properties).map(([name, schema]) =>
  {
    const req = requiredSet.has(name) ? ' (required)' : ' (optional)'
    const desc = schema.description ? ` — ${schema.description}` : ''
    return `    - ${name}: ${schema.type}${req}${desc}`
  })

  return `- **${tool.name}**: ${tool.description}\n  Parameters:\n${paramLines.join('\n')}`
}

// generate the tool block from the registry
function formatTools(tools: Tool[]): string
{
  return tools.map(formatTool).join('\n\n')
}

// summarize the project root so the model starts w/ lightweight repo context
function formatProjectContext(cwd: string): string
{
  let entries: string[]

  try
  {
    entries = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => !IGNORED_ROOT_ENTRIES.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, PROJECT_CONTEXT_LIMIT)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
  }
  catch
  {
    return `Project name: ${basename(cwd)}\nTop-level entries: unavailable`
  }

  const suffix = entries.length === PROJECT_CONTEXT_LIMIT ? ' (truncated)' : ''
  const summary = entries.length > 0 ? entries.join(', ') : '(empty)'
  return `Project name: ${basename(cwd)}\nTop-level entries${suffix}: ${summary}`
}

// build the complete system prompt for a given model & context
export function buildSystemPrompt(ctx: {
  model: string
  cwd: string
  tools: Tool[]
}): string
{
  const toolBlock = formatTools(ctx.tools)
  const projectContext = formatProjectContext(ctx.cwd)
  const injectedContext = gatherProjectContext(ctx.cwd)

  let prompt = `You are Coral, a local coding agent running via Ollama. You help developers by reading code, editing files, running shell commands, & answering questions about codebases.

Running model: ${ctx.model}

## Working Directory

You are working in: ${ctx.cwd}
All relative paths are resolved from this directory.

## Project Context

${projectContext}

## Tools

You have the following tools available:

${toolBlock}

## Rules

- Be concise & direct — show code, not explanations, unless asked
- Read files before editing them — never assume contents
- Use relative paths from the working directory
- When a task is ambiguous, ask for clarification rather than guessing
- Show relevant code snippets when explaining code
- Prefer surgical edits over full file rewrites — change only what needs to change
- For multi-step tasks, plan your approach before starting: read relevant files first, understand the context, then make changes
- When editing code, verify your changes by reading the file after writing to confirm correctness
- If a bash command fails, read the error carefully & try to fix the root cause rather than retrying blindly
- When you encounter something unexpected, explain what you found & ask the user how to proceed rather than making assumptions
- If a task requires changes across multiple files, explain the full plan before starting

## Planning & delegation

- For a multi-step task, call todo_write to lay out the steps, then keep it current: mark one item in_progress as you work it & completed when done. Skip it for simple single-step tasks
- Use task to delegate a bounded search or research question to a subagent — it explores with its own context (read-only) & returns just the answer, so a wide search doesn't crowd out your own. Give it self-contained instructions & say what to return
- Don't delegate edits or commands — the subagent is read-only; do those yourself

## Committing changes

- Only commit when asked; only push when asked
- Inspect first: git_status, then git_diff with stat:true for a per-file summary before diffing bodies
- Group related changes into focused commits — one logical change each, never one catch-all commit
- Keep each commit self-contained so history stays bisectable: tests & docs travel in the same commit as the code they cover, not batched separately at the end
- When splitting a dirty tree into several commits, stage explicit paths with git_add per group rather than git_add all:true
- Write conventional-commit subjects (feat:, fix:, refactor:, test:, docs:, chore:) under ~72 chars
- For a multi-file or non-obvious commit, add a short body explaining the why, not just the what
- Push with git_push only after the user asks`

  if (injectedContext)
  {
    prompt += `\n\n## Loaded Project Context\n\nThe following project files were auto-loaded for reference:\n\n${injectedContext}`
  }

  return prompt
}
