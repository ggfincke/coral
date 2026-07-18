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
import { runGitCommand } from '../../utils/git.js'
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

const diffCommand: Command = {
  name: 'diff',
  description: 'Show git diff of working directory',
  async execute(_args, ctx)
  {
    const cwd = ctx.getCwd()

    const result = await runGitCommand(['diff'], cwd, {
      allowStdoutOnError: true,
    })

    if (result.error)
    {
      ctx.pushOutput(
        systemBlock('Not a git repository, or git is not installed')
      )
      return
    }

    if (!result.output.trim())
    {
      ctx.pushOutput(systemBlock('No uncommitted changes'))
      return
    }

    // diff blocks render with a gutter and theme colors in the transcript
    ctx.pushOutput({ type: 'diff', unified: result.output })
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
