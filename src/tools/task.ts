// src/tools/task.ts
// delegate a bounded read-only research job to a fresh-context subagent

import type { Tool, ToolResult } from './tool.js'
import { getSubagentRunner } from './subagent.js'

export const taskTool: Tool = {
  name: 'task',
  description:
    'Delegate a focused research task to a subagent with its own context. The ' +
    'subagent can read files, search, & inspect git (read-only) but cannot ' +
    'edit, run shell, or commit. Use it to explore the codebase or answer a ' +
    'bounded question without spending your own context on the search. Returns ' +
    "the subagent's final report.",
  display: {
    label: 'Task',
    summarize: (args) => String(args.description ?? ''),
  },
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short label for the task (3-5 words)',
      },
      prompt: {
        type: 'string',
        description:
          'Self-contained instructions — the subagent sees only this, not the ' +
          'conversation, so include all needed context & state what to return',
      },
    },
    required: ['prompt'],
  },
  async execute(args): Promise<ToolResult>
  {
    const prompt = (args.prompt as string | undefined)?.trim()
    if (!prompt)
    {
      return { output: '', error: 'task requires a non-empty prompt' }
    }

    const runner = getSubagentRunner()
    if (!runner)
    {
      return { output: '', error: 'Subagents are unavailable in this context' }
    }

    const result = await runner(prompt)
    if (result.error)
    {
      return { output: result.text, error: result.error }
    }
    return { output: result.text || '(subagent returned no output)' }
  },
}
