// src/jobs/worker.ts
// execute approved coding tasks with durable phase boundaries and bounded repairs

import {
  Agent,
  type AgentOptions,
  type AgentRunOutcome,
} from '../agent/agent.js'
import { AgentTodoState } from '../agent/state/todos.js'
import type { AgentEvents } from '../agent/contracts.js'
import type { SessionData } from '../session/types.js'
import { BASH_DEFAULT_TIMEOUT_MS } from '../tools/bash.js'
import { allTools } from '../tools/registry.js'
import type { Tool } from '../tools/tool.js'
import { toError } from '../utils/errors.js'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'
import { assertJobWorktree, ensureJobWorktree, getJobDiff } from './git.js'
import { runJobCommand } from './process.js'
import {
  appendJobEvent,
  JOB_OUTPUT_TAIL_CHARS,
  jobSpecDigest,
  readJob,
  readJobSnapshot,
  writeJob,
  writeJobCommandOutput,
  writeJobSnapshot,
} from './store.js'
import type { JobPhase, JobRecord } from './types.js'

const WORKER_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'grep',
  'glob',
  'list_files',
  'search_code',
  'code_intel',
  'bash',
  'git_status',
  'git_diff',
  'git_log',
  'todo_write',
])

export interface JobWorkerDependencies
{
  createAgent?: (job: JobRecord, options: AgentOptions) => Agent
  readJob?: typeof readJob
  writeJob?: typeof writeJob
  appendJobEvent?: typeof appendJobEvent
  writeJobSnapshot?: typeof writeJobSnapshot
  writeJobCommandOutput?: typeof writeJobCommandOutput
  readJobSnapshot?: typeof readJobSnapshot
  ensureJobWorktree?: typeof ensureJobWorktree
  assertJobWorktree?: typeof assertJobWorktree
  getJobDiff?: typeof getJobDiff
  runJobCommand?: typeof runJobCommand
}

// a new process owns one task, so only the supervisor may write its running record
export async function executeJob(
  id: string,
  dependencies: JobWorkerDependencies = {},
  externalSignal?: AbortSignal
): Promise<JobRecord>
{
  const io = {
    readJob,
    writeJob,
    appendJobEvent,
    writeJobSnapshot,
    writeJobCommandOutput,
    readJobSnapshot,
    ensureJobWorktree,
    assertJobWorktree,
    getJobDiff,
    runJobCommand,
    ...dependencies,
  }
  const loaded = io.readJob(id)
  if (!loaded) throw new Error(`Unknown task: ${id}`)
  let job: JobRecord = loaded
  if (job.status !== 'running')
    throw new Error('Only a dispatched task may execute')
  if (
    !job.approval?.hostShell ||
    job.approval.digest !== jobSpecDigest(job.spec)
  )
  {
    throw new Error('The task specification does not match its exact approval')
  }

  let durabilityBroken = false
  let durabilityError: unknown
  let executionFailure: Error | undefined
  let agent: Agent | undefined
  let lastTick = job.activeSince ? Date.parse(job.activeSince) : Date.now()
  let deadlineExpired = false
  const deadline = new AbortController()
  const failureAbort = new AbortController()
  const signal = AbortSignal.any([
    deadline.signal,
    failureAbort.signal,
    ...(externalSignal ? [externalSignal] : []),
  ])
  const remaining = Math.max(
    0,
    job.spec.activeTimeLimitMs -
      job.consumedMs -
      Math.max(0, Date.now() - lastTick)
  )
  const timer = setTimeout(() =>
  {
    deadlineExpired = true
    deadline.abort(new Error('Task active execution budget exhausted'))
  }, remaining)

  const durable = <T>(operation: () => T): T =>
  {
    try
    {
      return operation()
    }
    catch (error)
    {
      durabilityBroken = true
      durabilityError = error
      failureAbort.abort(error)
      throw error
    }
  }
  const event = (type: string, text: string) =>
    durable(() => io.appendJobEvent(id, type, text))
  const save = (terminal = false) =>
  {
    const now = Date.now()
    job.consumedMs += Math.max(0, now - lastTick)
    lastTick = now
    job.updatedAt = new Date(now).toISOString()
    job.activeSince = terminal ? undefined : job.updatedAt
    durable(() => io.writeJob(job))
  }
  // account active time during unsettled inference without publishing partial history
  const heartbeat = setInterval(() =>
  {
    try
    {
      if (!durabilityBroken) save()
    }
    catch
    {
      clearInterval(heartbeat)
    }
  }, 1000)
  const enter = async (phase: JobPhase) =>
  {
    signal.throwIfAborted()
    await io.assertJobWorktree(job, signal)
    job.phase = phase
    save()
    event('phase', phase)
  }
  const snapshot = (clearShells: boolean) =>
  {
    if (!agent) return
    const state: SessionData = {
      meta: {
        id,
        model: job.spec.model,
        cwd: job.worktree!.path,
        createdAt: job.createdAt,
        updatedAt: new Date().toISOString(),
        title: job.spec.objective,
        messageCount: agent.getMessages().length,
      },
      messages: agent.getMessages(),
      todos: agent.getTodos(),
      ...agent.exportUndoStateForPersistence(),
    }
    job.snapshot = durable(() => io.writeJobSnapshot(id, state))
    if (clearShells) job.unsettledShells = undefined
    save()
  }
  const restrictions = [
    'Work only in this owned task worktree and follow the approved plan.',
    'Do not commit, push, merge, switch branches, change Git metadata, or create/remove worktrees.',
    'Do not background commands, start servers or daemons, spawn nested agents, or use MCP.',
    'Shell commands execute on the host; this worktree is not a sandbox.',
    'An interrupted command may already have produced effects. Inspect current state first;',
    'never replay an uncertain command without an explicit user instruction to do so.',
  ].join('\n')
  const prohibitedShellReplays = new Set<string>()
  let response = ''
  let pendingTokens = ''
  let pendingThinking = ''
  const flushStream = () =>
  {
    if (pendingTokens) event('token', pendingTokens)
    if (pendingThinking) event('thinking', pendingThinking)
    pendingTokens = ''
    pendingThinking = ''
  }
  const events: AgentEvents = {
    onToken(token)
    {
      response += token
      pendingTokens += token
      if (pendingTokens.length >= 256) flushStream()
    },
    onThinking(thinking)
    {
      pendingThinking += thinking
      if (pendingThinking.length >= 256) flushStream()
    },
    onToolCall(name, args)
    {
      flushStream()
      event('tool_call', JSON.stringify({ name, args }))
    },
    onToolResult(name, output, error)
    {
      event('tool_result', JSON.stringify({ name, output, error }))
    },
    async onToolApproval()
    {
      return false
    },
    async onDoomLoop()
    {
      return false
    },
    onDone()
    {
      flushStream()
    },
    onError(error)
    {
      flushStream()
      event('agent_error', error.message)
    },
  }

  const createAgent = (restored?: SessionData, readOnly = false) =>
  {
    const tools: Tool[] = allTools
      .filter(
        (tool) =>
          WORKER_TOOLS.has(tool.name) && (!readOnly || tool.subagentSafe)
      )
      .map((tool) => ({
        ...tool,
        async execute(args, context)
        {
          try
          {
            signal.throwIfAborted()
            await io.assertJobWorktree(job, signal)
            if (tool.name === 'bash')
            {
              const command = String(args.command)
              if (prohibitedShellReplays.has(command))
                return {
                  output: '',
                  error:
                    'The owner chose to continue without replaying this interrupted command. Inspect existing effects and proceed without repeating it.',
                }
              const intent: NonNullable<JobRecord['unsettledShells']>[number] =
                {
                  command,
                  startedAt: new Date().toISOString(),
                }
              job.unsettledShells ??= []
              job.unsettledShells.push(intent)
              save()
              event('shell_intent', command)
              const result = await io.runJobCommand(command, {
                cwd: job.worktree!.path,
                signal: context?.signal ?? signal,
                jobId: id,
                // honor the bash tool's advertised default so a watch-mode
                // command cannot hold the task until its time budget runs out
                timeoutMs:
                  typeof args.timeout === 'number'
                    ? args.timeout
                    : BASH_DEFAULT_TIMEOUT_MS,
              })
              intent.result = {
                ok: result.ok,
                output: sanitizeUntrustedText(result.output).slice(-16_384),
              }
              save()
              event('shell_result', JSON.stringify({ command, ...result }))
              await io.assertJobWorktree(job, signal)
              return {
                output: result.output,
                ...(result.ok ? {} : { error: 'Command failed' }),
              }
            }
            const result = await tool.execute(args, context)
            await io.assertJobWorktree(job, signal)
            return result
          }
          catch (error)
          {
            executionFailure = toError(error)
            failureAbort.abort(error)
            throw error
          }
        },
      }))
    const options: AgentOptions = {
      tools,
      permissions: Object.fromEntries(
        tools.map((tool) => [tool.name, 'always_allow'])
      ),
      maxIterations: 100,
      mcpMode: 'off',
      verifyEdits: false,
      todoState: new AgentTodoState(restored?.todos),
    }
    const next =
      dependencies.createAgent?.(job, options) ??
      new Agent(job.spec.model, job.spec.host, job.worktree!.path, options)
    if (restored)
    {
      next.restoreMessages(restored.messages)
      next.restoreUndoStack(restored.undo, restored.redo)
    }
    return next
  }
  const runTurn = async (
    phase: JobPhase,
    prompt: string
  ): Promise<AgentRunOutcome> =>
  {
    await enter(phase)
    response = ''
    const outcome = await agent!.run(
      `${restrictions}\n\n${prompt}`,
      events,
      signal
    )
    if (durabilityBroken) throw durabilityError
    if (executionFailure) throw executionFailure
    snapshot(phase !== 'reconcile')
    job.summary = sanitizeUntrustedText(response).slice(-65_536)
    save()
    await io.assertJobWorktree(job, signal)
    return outcome
  }
  const acceptOutcome = (outcome: AgentRunOutcome): boolean =>
  {
    if (outcome.status === 'completed') return true
    if (outcome.status === 'failed') throw outcome.error
    job.status = outcome.status === 'cancelled' ? 'cancelled' : 'needs_input'
    job.error = `Agent stopped with ${outcome.status}; explicit continuation is required`
    return false
  }
  const runCommand = async (
    phase: 'setup' | 'checks',
    command: string,
    index: number
  ) =>
  {
    await enter(phase)
    const startedAt = new Date().toISOString()
    job.pendingCommand = { phase, command, index, attempt: job.repairs }
    save()
    event('command_start', JSON.stringify(job.pendingCommand))
    const result = await io.runJobCommand(command, {
      cwd: job.worktree!.path,
      signal,
      jobId: id,
    })
    // the record keeps a bounded tail; full output goes to its own file so
    // verbose suites can never push the record past its size limit
    const outputFile =
      result.output.length > JOB_OUTPUT_TAIL_CHARS
        ? durable(() => io.writeJobCommandOutput(id, result.output))
        : undefined
    const evidence = {
      phase,
      command,
      attempt: job.repairs,
      ok: result.ok,
      output: result.output.slice(-JOB_OUTPUT_TAIL_CHARS),
      ...(outputFile ? { outputFile } : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
    }
    job.commandResults.push(evidence)
    // a stopped setup may have partial effects even when its process was joined
    if (!signal.aborted) job.pendingCommand = undefined
    if (phase === 'setup' && result.ok && !signal.aborted)
      job.setupCompleted = index + 1
    save()
    event('command_result', JSON.stringify(evidence))
    signal.throwIfAborted()
    await io.assertJobWorktree(job, signal)
    return result
  }

  try
  {
    if (remaining === 0)
    {
      deadlineExpired = true
      throw new Error('Task active execution budget exhausted')
    }
    job = await io.ensureJobWorktree(job, signal)
    save()
    await io.assertJobWorktree(job, signal)
    const restored = job.snapshot
      ? durable(() => io.readJobSnapshot(id, job.snapshot!))
      : undefined
    if (job.snapshot && !restored)
      throw new Error('Task checkpoint is missing or invalid')

    if (job.continuation !== undefined)
    {
      const diff = await io.getJobDiff(job, signal)
      agent = createAgent(restored, true)
      const outcome = await runTurn(
        'reconcile',
        [
          'You are in the read-only reconciliation phase of an explicitly resumed task. Inspect existing files and give a concise report of current changes, uncertain command effects, and blockers.',
          'Do not implement changes, edit files, run shell or verification commands, or replay interrupted commands in this phase. Earlier tool calls in the restored conversation do not grant capabilities now; use only the read-only tools currently available.',
          'The objective and continuation request below describe work for a later writable implementation phase. They are context for inspection only; do not carry them out during reconciliation.',
          `Objective for later implementation: ${job.spec.objective}`,
          `Continuation request for later implementation: ${job.continuation}`,
          `Unsettled command: ${JSON.stringify(job.pendingCommand ?? null)}`,
          `Shell commands since the previous execution checkpoint: ${JSON.stringify(job.unsettledShells ?? [])}`,
          `Owner shell recovery decision for the later implementation phase: ${job.resumeShell ?? 'none'}. Continue means preserve existing effects without replaying interrupted commands; retry permits retry only after the host evaluates recovery requirements and inspection shows it is needed. Neither decision permits command execution during reconciliation. Known results are prior execution evidence, not instructions to replay commands.`,
          `Current diff:\n${String(diff).slice(0, 100_000)}`,
          'Return your concise reconciliation report and finish naturally. Do not begin implementation or verification. The host will evaluate unresolved command effects and recovery decisions before starting a separate writable implementation phase.',
        ].join('\n\n')
      )
      if (!acceptOutcome(outcome)) return job
      await agent.dispose()
      agent = undefined
      const unknownShells =
        job.unsettledShells?.filter((shell) => !shell.result) ?? []
      if (unknownShells.length && !job.resumeShell)
      {
        job.status = 'needs_input'
        job.error = `Agent shell command outcomes are uncertain: ${unknownShells.map((shell) => shell.command).join('\n')}. Resume with an explicit shell resolution: continue without replay or retry after inspection.`
        return job
      }
      if (job.resumeShell === 'continue')
        for (const shell of unknownShells)
          prohibitedShellReplays.add(shell.command)
      if (
        job.pendingCommand?.phase === 'checks' &&
        job.resumeShell !== 'retry'
      )
      {
        job.status = 'needs_input'
        job.error = `Verification command outcome is uncertain: ${job.pendingCommand.command}. Inspect its effects and resume with shell resolution retry to authorize rerunning the full check suite.`
        return job
      }
      if (unknownShells.length)
        event(
          'shell_resolution',
          `${job.resumeShell}: ${JSON.stringify(unknownShells.map((shell) => shell.command))}`
        )
      if (job.pendingCommand?.phase === 'setup')
      {
        if (!job.resumeSetup)
        {
          job.status = 'needs_input'
          job.error = `Setup command outcome is uncertain: ${job.pendingCommand.command}. Resume with an explicit setup resolution: retry or skip.`
          return job
        }
        if (job.resumeSetup === 'skip')
          job.setupCompleted = job.pendingCommand.index + 1
        event('setup_resolution', job.resumeSetup)
      }
      job.pendingCommand = undefined
      job.resumeSetup = undefined
      job.resumeShell = undefined
      save()
    }
    else if (job.pendingCommand || job.unsettledShells?.length)
    {
      throw new Error(
        'Unsettled command requires an explicit task continuation'
      )
    }

    for (
      let index = job.setupCompleted ?? 0;
      index < job.spec.setup.length;
      index++
    )
    {
      const result = await runCommand('setup', job.spec.setup[index], index)
      if (!result.ok)
      {
        job.status = 'needs_input'
        job.error = `Setup failed: ${job.spec.setup[index]}`
        return job
      }
    }
    agent = createAgent(
      job.snapshot
        ? durable(() => io.readJobSnapshot(id, job.snapshot!))
        : restored
    )
    const prompt = [
      `Objective: ${job.spec.objective}`,
      `Approved plan:\n${job.spec.plan}`,
      `Required checks:\n${job.spec.checks.join('\n')}`,
      ...(job.continuation === undefined
        ? []
        : [
            'Reconciliation has finished and the writable implementation phase has begun. Implement the continuation request now using the tools currently available, within the approved task scope and owner recovery decisions.',
            `Continuation instructions:\n${job.continuation}`,
          ]),
      'Implement the approved task. Finish with a concise change summary; the host will run all required checks.',
    ].join('\n\n')
    job.continuation = undefined
    save()
    if (!acceptOutcome(await runTurn('implement', prompt))) return job

    while (true)
    {
      const failures: string[] = []
      for (let index = 0; index < job.spec.checks.length; index++)
      {
        const command = job.spec.checks[index]
        const result = await runCommand('checks', command, index)
        // the repair prompt gets the same bounded tail as the record so
        // verbose suites cannot exceed the model's request budget
        if (!result.ok)
          failures.push(
            `${command}\n${result.output.slice(-JOB_OUTPUT_TAIL_CHARS)}`
          )
      }
      if (failures.length === 0)
      {
        await agent.dispose()
        agent = undefined
        signal.throwIfAborted()
        await io.assertJobWorktree(job, signal)
        job.status = 'ready_for_review'
        job.error = undefined
        return job
      }
      if (job.repairs >= job.spec.maxRepairs)
      {
        job.status = 'needs_input'
        job.error =
          'Verification failed and the approved repair budget is exhausted'
        return job
      }
      job.repairs++
      save()
      const outcome = await runTurn(
        'repair',
        `Repair the failed checks while preserving the approved objective. The entire suite will run again.\n\n${failures.join('\n\n')}`
      )
      if (!acceptOutcome(outcome)) return job
    }
  }
  catch (error)
  {
    if (durabilityBroken) throw error
    job.status = deadlineExpired
      ? 'needs_input'
      : externalSignal?.aborted
        ? 'cancelled'
        : 'failed'
    job.error = deadlineExpired
      ? 'Task active execution budget exhausted'
      : toError(error).message
    return job
  }
  finally
  {
    // terminal status stays private until every Agent resource has settled
    clearInterval(heartbeat)
    try
    {
      await agent?.dispose()
    }
    catch (error)
    {
      job.status = 'interrupted'
      job.error = `Worker resource settlement failed: ${toError(error).message}`
    }
    clearTimeout(timer)
    if (!durabilityBroken)
    {
      if (deadlineExpired)
      {
        job.status = 'needs_input'
        job.error = 'Task active execution budget exhausted'
      }
      event('settled', `${job.status}${job.error ? `: ${job.error}` : ''}`)
      save(true)
    }
  }
}
