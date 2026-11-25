// src/tui/commands/workspace.ts
// workspace diff and semantic-index commands

import {
  buildIndexer,
  describeRetrievalFailure,
} from '../../retrieval/build.js'
import {
  DEFAULT_EMBEDDING_MODEL,
  type IndexStore,
} from '../../retrieval/types.js'
import { runGitCommand, type GitCommandResult } from '../../utils/git.js'
import { flattenUntrustedText } from '../../utils/untrusted-text.js'
import { style } from '../theme.js'
import type { Command } from './contracts.js'
import {
  formatIndexError,
  formatIndexProgress,
  formatIndexResult,
  formatIndexStart,
} from './workspace-output.js'
import { systemBlock } from './output.js'

// /diff command

// untracked paths listed before the rest collapse into a count
const MAX_UNTRACKED_LISTED = 50

// staged & unstaged changes to tracked files; an unborn HEAD has nothing to
// diff against, so it shows the index and worktree diffs one after another
async function trackedChanges(cwd: string): Promise<GitCommandResult>
{
  const head = await runGitCommand(
    ['rev-parse', '--verify', '--quiet', 'HEAD'],
    cwd
  )
  const diffs = head.error
    ? [['diff', '--cached'], ['diff']]
    : [['diff', 'HEAD']]
  const outputs: string[] = []
  for (const args of diffs)
  {
    const result = await runGitCommand(args, cwd, { allowStdoutOnError: true })
    if (result.error) return result
    if (result.output.trim()) outputs.push(result.output)
  }
  return { output: outputs.join('\n') }
}

// untracked, non-ignored paths across the whole repo, relative to its root;
// untracked directories collapse to one entry & empty ones are skipped,
// like git status does
async function untrackedPaths(cwd: string): Promise<string[] | undefined>
{
  const result = await runGitCommand(
    [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--directory',
      '--no-empty-directory',
      '--full-name',
      '-z',
      '--',
      ':/',
    ],
    cwd
  )
  if (result.error) return undefined
  return result.output.split('\0').filter(Boolean)
}

// names are flattened to one row so a crafted name cannot fake extra entries
function formatUntracked(paths: string[]): string
{
  const listed = paths
    .slice(0, MAX_UNTRACKED_LISTED)
    .map((path) => `  ${flattenUntrustedText(path)}`)
  const hidden = paths.length - listed.length
  if (hidden > 0) listed.push(`  ... ${hidden} more`)
  return `Untracked files:\n${listed.join('\n')}`
}

const diffCommand: Command = {
  name: 'diff',
  description: 'Show staged, unstaged, & untracked changes',
  async execute(_args, ctx)
  {
    const cwd = ctx.getCwd()

    const [tracked, untracked] = await Promise.all([
      trackedChanges(cwd),
      untrackedPaths(cwd),
    ])

    if (tracked.error)
    {
      ctx.pushOutput(
        systemBlock('Not a git repository, or git is not installed')
      )
      return
    }

    if (!tracked.output.trim() && untracked?.length === 0)
    {
      ctx.pushOutput(systemBlock('No uncommitted changes'))
      return
    }

    // diff blocks render with a gutter and theme colors in the transcript
    if (tracked.output.trim())
    {
      ctx.pushOutput({ type: 'diff', unified: tracked.output })
    }
    if (untracked === undefined)
    {
      ctx.pushOutput(
        systemBlock('Untracked files: unknown (git ls-files failed)')
      )
    }
    else if (untracked.length > 0)
    {
      ctx.pushOutput(systemBlock(formatUntracked(untracked)))
    }
  },
}

// /index command

// guard direct or re-entrant dispatch even though App serializes interactive commands
let indexBuilding = false

const indexCommand: Command = {
  name: 'index',
  description:
    'Build the semantic code index (/index rebuild forces a rebuild)',
  async execute(args, ctx)
  {
    if (indexBuilding)
    {
      ctx.pushOutput(systemBlock('Index build already in progress'))
      return
    }

    const arg = args.trim().toLowerCase()
    if (arg && arg !== 'rebuild' && arg !== 'force')
    {
      ctx.pushOutput(
        systemBlock(
          `Unknown option: "${arg}"\n` +
            `Usage: ${style('user')('/index')} or ${style('user')('/index rebuild')}`
        )
      )
      return
    }

    const force = arg === 'rebuild' || arg === 'force'
    const cwd = ctx.getCwd()
    let store: IndexStore | undefined
    let embeddingModel = DEFAULT_EMBEDDING_MODEL

    indexBuilding = true
    ctx.pushOutput(systemBlock(formatIndexStart(cwd, force)))

    try
    {
      const build = ctx.buildIndexer ?? buildIndexer
      const built = await build(cwd, ctx.host, ctx.signal)
      store = built.store
      embeddingModel = built.embeddingModel

      const stats = await built.indexer.ensureIndexed({
        force,
        onProgress: (progress) =>
        {
          // ~10 throttled updates on big repos; quiet on small ones
          if (progress.total < 20) return
          const step = Math.max(1, Math.floor(progress.total / 10))
          if (
            progress.processed % step === 0 &&
            progress.processed < progress.total
          )
          {
            ctx.pushOutput(
              systemBlock(
                formatIndexProgress(progress.processed, progress.total)
              )
            )
          }
        },
      })

      const resultBlock = systemBlock(formatIndexResult(stats))
      if (ctx.signal?.aborted) ctx.pushTerminalOutput(resultBlock)
      else ctx.pushOutput(resultBlock)
    }
    catch (err)
    {
      if (ctx.signal?.aborted)
      {
        ctx.pushTerminalOutput(systemBlock('Indexing interrupted'))
        return
      }
      const failure = describeRetrievalFailure(err, embeddingModel)
      ctx.pushOutput(
        systemBlock(
          formatIndexError(
            failure.embeddingModel,
            failure.message,
            failure.missingModel
          )
        )
      )
    }
    finally
    {
      store?.close?.()
      indexBuilding = false
    }
  },
}

export const workspaceCommands = {
  diff: diffCommand,
  index: indexCommand,
} satisfies Record<string, Command>
