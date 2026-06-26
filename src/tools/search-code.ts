// src/tools/search-code.ts
// semantic code search backed by local Ollama embeddings

import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import { getCwd } from '../cwd.js'
import { DEFAULT_OLLAMA_HOST } from '../ollama/host.js'
import { buildIndexer, type RetrievalDeps } from '../retrieval/build.js'
import { DEFAULT_LIMIT } from '../retrieval/indexer.js'
import {
  DEFAULT_EMBEDDING_MODEL,
  type IndexStore,
  type SearchHit,
} from '../retrieval/types.js'
import { formatAttachedFileBlock } from '../utils/attached-file.js'
import {
  isMissingModelError,
  toErrorMessage,
  withPullHint,
} from '../utils/errors.js'

const MAX_SNIPPET_LINES = 12
const MAX_SNIPPET_CHARS = 1_200

function formatSnippet(text: string): string
{
  const lines = text.split('\n')
  const clippedLines = lines.slice(0, MAX_SNIPPET_LINES)
  let snippet = clippedLines.join('\n')

  if (lines.length > MAX_SNIPPET_LINES)
  {
    snippet += '\n...'
  }

  if (snippet.length > MAX_SNIPPET_CHARS)
  {
    snippet = snippet.slice(0, MAX_SNIPPET_CHARS).trimEnd() + '\n...'
  }

  return snippet
}

function formatHits(hits: SearchHit[]): string
{
  if (hits.length === 0)
  {
    return 'No semantically similar code chunks found.'
  }

  return hits
    .map((hit, index) =>
    {
      const location = `${hit.path}:${hit.startLine}-${hit.endLine}`
      const score = hit.score.toFixed(3)
      const label = `${index + 1}. ${location} (score ${score})`
      return formatAttachedFileBlock(label, formatSnippet(hit.text), {
        fence: 'text',
      })
    })
    .join('\n\n')
}

function formatSearchError(embeddingModel: string, message: string): string
{
  const base = `search_code failed while using embedding model ${embeddingModel}: ${message}`
  if (!isMissingModelError(message)) return base

  return withPullHint(base, embeddingModel, '. ')
}

export function createSearchCodeTool(dependencies: RetrievalDeps = {}): Tool
{
  return {
    name: 'search_code',
    description:
      'Semantically search the current project for code related to a natural-language query. Returns ranked file chunks with line ranges.',
    subagentSafe: true,
    display: {
      label: 'Search Code',
      summarize: (args) => String(args.query ?? ''),
    },
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language description of the code to find',
        },
        topK: {
          type: 'number',
          description: `Number of ranked chunks to return (default ${DEFAULT_LIMIT})`,
        },
      },
      required: ['query'],
    },
    async execute(
      args: Record<string, unknown>,
      context?: ToolExecutionContext
    ): Promise<ToolResult>
    {
      const query = (args.query as string | undefined)?.trim()
      if (!query)
      {
        return { output: '', error: 'search_code requires a non-empty query' }
      }

      // clamping & defaulting live in ProjectIndexer.search
      const topK = typeof args.topK === 'number' ? args.topK : undefined
      const cwd = context?.cwd ?? getCwd()
      const ollamaHost = context?.ollamaHost ?? DEFAULT_OLLAMA_HOST
      let embeddingModel = DEFAULT_EMBEDDING_MODEL
      let store: IndexStore | undefined

      try
      {
        const built = buildIndexer(
          cwd,
          ollamaHost,
          context?.signal,
          dependencies
        )
        embeddingModel = built.embeddingModel
        store = built.store

        const hits = await built.indexer.search(query, topK)

        return { output: formatHits(hits) }
      }
      catch (err)
      {
        const message = toErrorMessage(err)
        return {
          output: '',
          error: formatSearchError(embeddingModel, message),
        }
      }
      finally
      {
        store?.close?.()
      }
    },
  }
}

export const searchCodeTool: Tool = createSearchCodeTool()
