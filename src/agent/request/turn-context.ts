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
  private readonly attachmentReader?: AttachmentReader
  private readonly gitBuilder: NonNullable<
    TurnContextDependencies['buildGitContext']
  >

  constructor(cwd: string, dependencies: TurnContextDependencies = {})
  {
    this.cwd = cwd
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
    return Object.freeze({ input, attachments })
  }

  materialize(
    captured: CapturedTurn,
    maxChars: number
  ): AttachmentMaterialization
  {
    return materializeAttachments(captured.attachments, maxChars)
  }

  gatherGit(signal?: AbortSignal): Promise<OllamaMessage | null>
  {
    return this.gitBuilder(this.cwd, signal)
  }
}
