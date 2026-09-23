// src/cli/args.ts
// lightweight shared argument parsing before loading either execution runtime

import { Command, CommanderError, Option } from 'commander'
import { createRequire } from 'node:module'
import { DEFAULT_OLLAMA_HOST } from '../ollama/host.js'
export type ExecPermissionProfile = 'read-only' | 'workspace-write'
export type ExecOutputFormat = 'text' | 'json' | 'stream-json'

const { version } = createRequire(import.meta.url)('../../package.json') as {
  version: string
}

export interface CliOptions
{
  model?: string
  host: string
  think: boolean
  cwd?: string
  prompt?: string
  yolo?: boolean
  resume?: boolean
  session?: string
  sessions?: boolean
  theme?: string
  promptFile?: string
  permissionProfile: ExecPermissionProfile
  outputFormat: ExecOutputFormat
  resultFile?: string
  mcp: boolean
}

export type ParsedCli =
  | { kind: 'interactive' | 'exec'; options: CliOptions }
  | { kind: 'exit'; code: number }

export function parseCliArgs(argv: string[]): ParsedCli
{
  let parsed: ParsedCli | undefined
  const program = new Command()
    .name('coral')
    .description('A local-first CLI/TUI coding agent for Ollama')
    .version(version)
    .addHelpCommand('help [command]', 'display help for a command')
    .option('-m, --model <model>', 'Ollama model to use')
    .option('--host <url>', 'Ollama host URL', DEFAULT_OLLAMA_HOST)
    .option('--no-think', 'disable streamed reasoning requests')
    .option(
      '-C, --cwd <path>',
      'workspace directory (does not change the shell directory)'
    )
    .option('--yolo', 'auto-approve gated calls; denies stay blocked')
    .option(
      '--resume',
      'resume the newest usable session; -C restricts the workspace'
    )
    .option('--session <id>', 'resume an exact ID or unique ID prefix')
    .option('--sessions', 'list saved sessions and exit')
    .option('--theme <name>', 'color theme (see /theme)')
    .argument('[prompt]', 'initial prompt, submitted once after startup')
    .exitOverride()
    .action((prompt: string | undefined, _opts, command: Command) =>
    {
      parsed = {
        kind: 'interactive',
        options: { ...command.optsWithGlobals<CliOptions>(), prompt },
      }
    })
  program
    .command('exec')
    .description('Run one noninteractive, ephemeral agent turn')
    .argument('[prompt]', 'prompt text; quote multiword prompts')
    .version(version)
    .option(
      '--prompt-file <path>',
      'read a UTF-8 file; - reads stdin (maximum 1 MiB)'
    )
    .addOption(
      new Option('--permission-profile <profile>', 'headless tool profile')
        .choices(['read-only', 'workspace-write'])
        .default('read-only')
    )
    .addOption(
      new Option('--output-format <format>', 'stdout format')
        .choices(['text', 'json', 'stream-json'])
        .default('text')
    )
    .option('--result-file <path>', 'atomically write the structured result')
    .option(
      '--ephemeral',
      'compatibility marker; exec never persists a conversation'
    )
    .option('--mcp', 'enable pre-trusted, always-allowed MCP tools', false)
    .option('--no-mcp', 'disable configured MCP servers')
    .addHelpText(
      'after',
      '\nShared options: -m/--model, --host, --no-think, -C/--cwd, -V/--version.\nA model is required for exec. Inference uses only the configured Ollama host.'
    )
    .action((prompt: string | undefined, _opts, command: Command) =>
    {
      parsed = {
        kind: 'exec',
        options: { ...command.optsWithGlobals<CliOptions>(), prompt },
      }
    })
  try
  {
    program.parse(argv, { from: 'user' })
    return parsed ?? { kind: 'exit', code: 0 }
  }
  catch (error)
  {
    if (error instanceof CommanderError)
      return { kind: 'exit', code: error.exitCode === 0 ? 0 : 1 }
    throw error
  }
}
