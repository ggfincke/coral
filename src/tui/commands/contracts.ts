// src/tui/commands/contracts.ts
// neutral slash-command contracts

import type { Agent } from '../../agent/agent.js'
import type { BuiltIndexer } from '../../retrieval/build.js'
import type { CommandSummary } from '../prompt/completion.js'
import type {
  LifecycleChangeResult,
  SessionSaveResult,
} from '../session/interactive-runtime.js'
import type { OutputBlock } from '../transcript/types.js'

export interface CommandInfo extends CommandSummary
{
  aliases: string[]
}

// application capabilities available to every command
export interface CommandContext
{
  agent: Agent
  activeModel: string
  host: string
  yolo: boolean
  sessionLabelId: string | null
  pushOutput: (...blocks: OutputBlock[]) => void
  pushTerminalOutput: (...blocks: OutputBlock[]) => void
  clearSession: () => void
  rebuildTranscript: () => void
  resetTokenUsage: () => void
  reopenModelPicker: () => void
  switchModel: (modelName: string) => Promise<LifecycleChangeResult>
  getCwd: () => string
  signal?: AbortSignal
  buildIndexer?: (
    cwd: string,
    ollamaHost: string,
    signal?: AbortSignal
  ) => BuiltIndexer | Promise<BuiltIndexer>
  setYolo: (yolo: boolean) => Promise<void>
  exitApp: () => void
  resumeSession: (sessionId: string) => boolean
  saveCurrentSession: () => SessionSaveResult
  renameCurrentSession: (title: string) => boolean
  notifyThemeChanged: () => void
}

export interface Command
{
  name: string
  aliases?: string[]
  description: string
  execute: (args: string, ctx: CommandContext) => void | Promise<void>
}

export interface ParsedCommand
{
  name: string
  args: string
}
