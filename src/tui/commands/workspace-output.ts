// src/tui/commands/workspace-output.ts
// format semantic-index command progress and failures

import chalk from 'chalk'
import type { IndexStats } from '../../retrieval/types.js'
import { withPullHint } from '../../utils/errors.js'

export function formatIndexStart(cwd: string, force: boolean): string
{
  return force
    ? `Rebuilding semantic index for ${chalk.dim(cwd)}…`
    : `Indexing ${chalk.dim(cwd)}…`
}

export function formatIndexProgress(processed: number, total: number): string
{
  return chalk.dim(`  embedded ${processed}/${total} files`)
}

export function formatIndexResult(stats: IndexStats): string
{
  if (stats.totalFiles === 0) return 'No indexable files found'
  if (stats.embeddedFiles === 0)
  {
    return `Index already up to date (${stats.totalFiles} files)`
  }
  return `Indexed ${stats.embeddedFiles}/${stats.totalFiles} files · ${stats.chunks} chunks`
}

export function formatIndexError(
  embeddingModel: string,
  message: string,
  missingModel = false
): string
{
  const base = `Index build failed (embedding model ${embeddingModel}): ${message}`
  if (!missingModel) return base
  return withPullHint(base, embeddingModel, '\n')
}
