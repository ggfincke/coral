// src/agent/effects/replay.ts
// coordinate conversation, file, and todo replay

import type { TodoState } from '../../types/todo.js'
import type { UndoResult } from '../../types/undo.js'
import type { ConversationState } from '../state/conversation.js'
import { applyFileChanges, revertFileChanges } from './file-replay.js'

// * Coordinate revision-checked replay across state, todos, and disk
export class ReplayCoordinator
{
  constructor(
    private readonly state: ConversationState,
    private readonly todoState: TodoState,
    private readonly cwd: string
  )
  {}

  async undoLastTurn(signal?: AbortSignal): Promise<UndoResult>
  {
    signal?.throwIfAborted()
    const prepared = this.state.prepareUndo()
    if (prepared.status === 'empty')
    {
      return { ok: false, message: 'Nothing to undo' }
    }
    if (prepared.status === 'misaligned')
    {
      return {
        ok: false,
        message: 'Cannot undo after compaction or history changes',
      }
    }
    const turn = prepared.turn

    const reverted = await revertFileChanges(turn.changes, {
      cwd: this.cwd,
      signal,
    })
    if (!reverted.ok)
    {
      return { ok: false, message: reverted.error }
    }

    if (turn.todoChange) this.todoState.replace(turn.todoChange.before)
    const committed = this.state.commitReplay(prepared.plan)
    if (committed.status === 'stale')
    {
      if (turn.todoChange) this.todoState.replace(turn.todoChange.after)
      const rollback = await applyFileChanges(turn.changes, { cwd: this.cwd })
      return {
        ok: false,
        message: rollback.ok
          ? 'Cannot undo after concurrent history changes'
          : `Cannot undo after concurrent history changes; rollback failed: ${rollback.error}`,
      }
    }

    return {
      ok: true,
      message: 'Undid last turn',
      removedMessages: committed.removedMessages,
      changedFiles: reverted.changedFiles,
    }
  }

  async redoLastTurn(signal?: AbortSignal): Promise<UndoResult>
  {
    signal?.throwIfAborted()
    const prepared = this.state.prepareRedo()
    if (prepared.status === 'empty')
    {
      return { ok: false, message: 'Nothing to redo' }
    }
    if (prepared.status === 'misaligned')
    {
      return {
        ok: false,
        message: 'Cannot redo after compaction or history changes',
      }
    }
    const turn = prepared.turn

    const applied = await applyFileChanges(turn.changes, {
      cwd: this.cwd,
      signal,
    })
    if (!applied.ok)
    {
      return { ok: false, message: applied.error }
    }

    if (turn.todoChange) this.todoState.replace(turn.todoChange.after)
    const committed = this.state.commitReplay(prepared.plan)
    if (committed.status === 'stale')
    {
      if (turn.todoChange) this.todoState.replace(turn.todoChange.before)
      const rollback = await revertFileChanges(turn.changes, { cwd: this.cwd })
      return {
        ok: false,
        message: rollback.ok
          ? 'Cannot redo after concurrent history changes'
          : `Cannot redo after concurrent history changes; rollback failed: ${rollback.error}`,
      }
    }

    return {
      ok: true,
      message: 'Redid last turn',
      restoredMessages: committed.restoredMessages,
      changedFiles: applied.changedFiles,
    }
  }
}
