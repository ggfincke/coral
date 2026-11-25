// src/tui/commands/workspace-output.ts
// format semantic-index command progress and failures

import chalk from 'chalk'
import type { IndexStats } from '../../retrieval/types.js'
import { withPullHint } from '../../utils/errors.js'

const MAX_SKIPPED_PATHS_SHOWN = 3

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

// name a few skipped paths so an unreadable or busy file stays diagnosable
function formatSkippedFiles(paths: string[]): string
{
  if (paths.length === 0) return ''
  const shown = paths.slice(0, MAX_SKIPPED_PATHS_SHOWN).join(', ')
  const more =
    paths.length > MAX_SKIPPED_PATHS_SHOWN
      ? `, +${paths.length - MAX_SKIPPED_PATHS_SHOWN} more`
      : ''
  const noun = paths.length === 1 ? 'file' : 'files'
  return `\nSkipped ${paths.length} unreadable or still-changing ${noun}: ${shown}${more}`
}

export function formatIndexResult(stats: IndexStats): string
{
  const skipped = formatSkippedFiles(stats.skippedFiles)
  if (stats.totalFiles === 0) return `No indexable files found${skipped}`
  if (stats.embeddedFiles === 0)
  {
    return `Index already up to date (${stats.totalFiles} files)${skipped}`
  }
  return `Indexed ${stats.embeddedFiles}/${stats.totalFiles} files · ${stats.chunks} chunks${skipped}`
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
