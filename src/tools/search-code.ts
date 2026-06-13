// src/tools/search-code.ts
// semantic code search backed by local Ollama embeddings

import type { Tool, ToolResult } from './tool.js'
import { getCwd } from '../cwd.js'
import { getOllamaHost } from '../ollama/host.js'
import { OllamaClient } from '../ollama/client.js'
import { resolveRetrievalConfig } from '../config/retrieval.js'
import { DEFAULT_LIMIT, ProjectIndexer } from '../retrieval/indexer.js'
import { OllamaEmbedder } from '../retrieval/ollama-embedder.js'
import { SqliteIndexStore } from '../retrieval/sqlite-store.js'
import type { SearchHit } from '../retrieval/types.js'
import { toErrorMessage } from '../utils/errors.js'

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
      return `${index + 1}. ${location} (score ${score})\n\`\`\`text\n${formatSnippet(hit.text)}\n\`\`\``
    })
    .join('\n\n')
}

export const searchCodeTool: Tool = {
  name: 'search_code',
  description:
    'Semantically search the current project for code related to a natural-language query. Returns ranked file chunks with line ranges.',
  readOnly: true,
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
  async execute(args: Record<string, unknown>): Promise<ToolResult>
  {
    const query = (args.query as string | undefined)?.trim()
    if (!query)
    {
      return { output: '', error: 'search_code requires a non-empty query' }
    }

    // clamping & defaulting live in ProjectIndexer.search
    const topK = typeof args.topK === 'number' ? args.topK : undefined
    const cwd = getCwd()
    const config = resolveRetrievalConfig(cwd)
    const store = new SqliteIndexStore()

    try
    {
      const client = new OllamaClient(getOllamaHost())
      const embedder = new OllamaEmbedder(client, config.embeddingModel)
      const indexer = new ProjectIndexer(cwd, embedder, store)
      const hits = await indexer.search(query, topK)

      return { output: formatHits(hits) }
    }
    catch (err)
    {
      const message = toErrorMessage(err)
      return {
        output: '',
        error:
          `search_code failed with embedding model ${config.embeddingModel}: ${message}. ` +
          `If the model is missing, run: ollama pull ${config.embeddingModel}`,
      }
    }
    finally
    {
      store.close()
    }
  },
}
