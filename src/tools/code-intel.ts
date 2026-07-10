// src/tools/code-intel.ts
// typescript & javascript code intelligence tool

import type { CodeIntelOperation } from '../lsp/client.js'
import { isCodeIntelPath } from '../lsp/client.js'
import { toErrorMessage } from '../utils/errors.js'
import { checkWorkspacePath } from './path-policy.js'
import type { Tool } from './tool.js'

const OPERATIONS: CodeIntelOperation[] = [
  'definition',
  'references',
  'hover',
  'diagnostics',
]

function isOperation(value: unknown): value is CodeIntelOperation
{
  return (
    typeof value === 'string' &&
    OPERATIONS.includes(value as CodeIntelOperation)
  )
}

function validPosition(value: unknown): value is number
{
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

export const codeIntelTool: Tool = {
  name: 'code_intel',
  description:
    'Query TypeScript or JavaScript language-server intelligence. Operations: definition, references, hover, diagnostics. Position operations use 1-based line and character values; diagnostics only needs a path.',
  subagentSafe: true,
  display: {
    label: 'Code Intel',
    summarize: (args) =>
    {
      const location =
        validPosition(args.line) && validPosition(args.character)
          ? `:${args.line}:${args.character}`
          : ''
      return `${String(args.operation ?? '')} ${String(args.path ?? '')}${location}`.trim()
    },
  },
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: OPERATIONS,
        description: 'definition, references, hover, or per-file diagnostics',
      },
      path: {
        type: 'string',
        description:
          'Absolute or workspace-relative TypeScript/JavaScript path',
      },
      line: {
        type: 'number',
        description: '1-based line for definition, references, or hover',
      },
      character: {
        type: 'number',
        description: '1-based UTF-16 character for position operations',
      },
    },
    required: ['operation', 'path'],
  },
  async execute(args, context)
  {
    if (!isOperation(args.operation))
    {
      return {
        output: '',
        error: `code_intel operation must be one of: ${OPERATIONS.join(', ')}`,
      }
    }

    const cwd = context?.cwd ?? process.cwd()
    const allowed = await checkWorkspacePath(
      cwd,
      typeof args.path === 'string' ? args.path : undefined,
      context?.allowOutsideWorkspace === true
    )
    if (!allowed.ok) return { output: '', error: allowed.error }
    if (!isCodeIntelPath(allowed.path))
    {
      return {
        output: '',
        error:
          'code_intel supports .ts, .tsx, .mts, .cts, .js, .jsx, .mjs, and .cjs files',
      }
    }
    if (args.operation !== 'diagnostics')
    {
      if (!validPosition(args.line) || !validPosition(args.character))
      {
        return {
          output: '',
          error: `${args.operation} requires 1-based integer line and character values`,
        }
      }
    }
    if (!context?.codeIntel)
    {
      return { output: '', error: 'code_intel is unavailable in this session' }
    }

    try
    {
      const output = await context.codeIntel.query({
        operation: args.operation,
        path: allowed.path,
        line: args.line as number | undefined,
        character: args.character as number | undefined,
        signal: context.signal,
      })
      return { output }
    }
    catch (error)
    {
      return {
        output: '',
        error: `code_intel ${args.operation} failed: ${toErrorMessage(error)}`,
      }
    }
  },
}
