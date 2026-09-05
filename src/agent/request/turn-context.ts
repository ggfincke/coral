// src/agent/request/turn-context.ts
// durable turn capture and volatile context boundary

import type { OllamaMessage } from '../../types/inference.js'
import type { AttachmentReader } from './attachments.js'
import {
  captureAttachments,
  materializeAttachments,
  type AttachmentCapture,
  type AttachmentMaterialization,
} from './attachments.js'
import { buildGitContextMessage } from './git-context.js'
import { FileChangeContext } from './file-changes.js'

export interface TurnInput
{
  content: string
  attachmentPaths?: readonly string[]
}

export interface CapturedTurn
{
  readonly input: TurnInput
  readonly attachments: AttachmentCapture
}

export interface TurnContextDependencies
{
  attachmentReader?: AttachmentReader
  buildGitContext?: (
    cwd: string,
    signal?: AbortSignal
  ) => Promise<OllamaMessage | null>
}

// capture durable inputs separately from request-only repository state
export class TurnContextAssembler
{
  private readonly cwd: string
  private readonly fileChanges?: FileChangeContext
  private readonly attachmentReader?: AttachmentReader
  private readonly gitBuilder: NonNullable<
    TurnContextDependencies['buildGitContext']
  >

  constructor(
    cwd: string,
    dependencies: TurnContextDependencies = {},
    trackFileChanges = false
  )
  {
    this.cwd = cwd
    this.fileChanges = trackFileChanges ? new FileChangeContext(cwd) : undefined
    this.attachmentReader = dependencies.attachmentReader
    this.gitBuilder = dependencies.buildGitContext ?? buildGitContextMessage
  }

  async capture(
    input: TurnInput,
    signal?: AbortSignal,
    renderedCharAllowance?: number
  ): Promise<CapturedTurn>
  {
    signal?.throwIfAborted()
    const attachments = await captureAttachments(input.attachmentPaths ?? [], {
      cwd: this.cwd,
      signal,
      read: this.attachmentReader,
      renderedCharAllowance,
    })
    signal?.throwIfAborted()
    for (const entry of attachments.entries)
    {
      if (entry.status === 'captured')
      {
        // capture may be omitted later; retain earlier observations until commit
        this.fileChanges?.observe(entry.path, entry.content, false)
      }
    }
    return Object.freeze({ input, attachments })
  }

  materialize(
    captured: CapturedTurn,
    maxChars: number
  ): AttachmentMaterialization
  {
    return materializeAttachments(captured.attachments, maxChars)
  }

  commitAttachments(
    captured: CapturedTurn,
    materialization: AttachmentMaterialization
  ): void
  {
    const completePaths = new Set(
      materialization.attached
        .filter((entry) => !entry.truncated)
        .map((entry) => entry.path)
    )
    for (const entry of captured.attachments.entries)
    {
      if (entry.status === 'captured' && completePaths.has(entry.path))
      {
        this.observeFile(entry.path, entry.content)
      }
    }
  }

  gatherGit(signal?: AbortSignal): Promise<OllamaMessage | null>
  {
    return this.gitBuilder(this.cwd, signal)
  }

  observeFile(path: string, content: string): void
  {
    this.fileChanges?.observe(path, content)
  }

  invalidateFiles(paths: readonly string[] | null): void
  {
    this.fileChanges?.invalidate(paths)
  }

  gatherFileChanges(signal?: AbortSignal): Promise<OllamaMessage | null>
  {
    return this.fileChanges?.gather(signal) ?? Promise.resolve(null)
  }

  clearFileObservations(): void
  {
    this.fileChanges?.clear()
  }

  dispose(): void
  {
    this.fileChanges?.dispose()
  }
}
