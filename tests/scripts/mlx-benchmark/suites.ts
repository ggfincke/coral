// tests/scripts/mlx-benchmark/suites.ts
// live correctness, tool, context, lifecycle, and performance case drivers

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvents } from '../../../src/agent/agent.js'
import { defaultToolPermissions } from '../../../src/config/permissions.js'
import type { ReliabilityStats } from '../../../src/types/inference.js'
import type { Tool } from '../../../src/tools/tool.js'
import { TASKS } from '../eval/tasks.js'
import type { EvalTask } from '../eval/types.js'
import { BENCHMARK_POLICY } from './manifest.js'
import {
  MeasuredInferenceClient,
  requestMetrics,
  type RequestMeasurement,
} from './measure.js'
import { ProcessTreeRssSampler } from './process.js'
import { processTreeRss } from './process.js'
import type { BenchmarkRuntime } from './providers.js'
import type {
  HardGateObservation,
  MetricVector,
  ModelPair,
  ResidencyMemorySnapshot,
  ToolEvidence,
} from './types.js'

const SENTINEL = 'CORAL-BENCHMARK-8137'
const LIFECYCLE_PROBE_TIMEOUT_MS = 30_000

export interface BenchmarkExecutionLimits
{
  maxOutputTokens: number
  requestTimeoutMs: number
}

interface AgentCaseResult
{
  passed: boolean
  detail: string
  finalText: string
  toolEvidence: ToolEvidence
  measurements: RequestMeasurement[]
  wallMs: number
  peakRssBytes: number
}

interface ToolCase
{
  id: string
  prompt: string
  expectedCalls: number
  think: boolean
  grade(
    args: Record<string, unknown>[],
    finalText: string,
    measurements: RequestMeasurement[]
  ): Partial<ToolEvidence> & { passed: boolean; detail: string }
  secondPrompt?: string
}

function reliabilityEvidence(
  stats: ReliabilityStats,
  measurements: RequestMeasurement[],
  actualCalls: number,
  toolErrors: number
): ToolEvidence
{
  return {
    actualCalls,
    toolErrors,
    repairedToolCalls: stats.repairedToolCalls,
    nameRepairs: stats.nameRepairs,
    stallNudges: stats.stallNudges,
    validationFailures: stats.validationFailures,
    editRepairs: stats.editRepairs,
    reprompts: stats.reprompts,
    maxCallsInResponse: measurements.reduce(
      (max, item) => Math.max(max, item.toolCalls.length),
      0
    ),
    thinkingChars: measurements.reduce(
      (sum, item) => sum + item.thinkingChars,
      0
    ),
  }
}

function latestAssistant(agent: Agent): string
{
  return (
    agent.getMessages().findLast((message) => message.role === 'assistant')
      ?.content ?? ''
  )
}

function eventSink(counters: {
  calls: number
  errors: number
  agentErrors: number
}): AgentEvents
{
  return {
    onToken()
    {},
    onThinking()
    {},
    onToolCall()
    {},
    onToolResult(_name, _output, error)
    {
      counters.calls++
      if (error !== undefined) counters.errors++
    },
    onToolApproval: async () => true,
    onDoomLoop: async () => false,
    onVerification()
    {},
    onUsage()
    {},
    onCompactionStart()
    {},
    onCompaction()
    {},
    onDone()
    {},
    onError()
    {
      counters.agentErrors++
    },
  }
}

async function runAgentCase(options: {
  runtime: BenchmarkRuntime
  pair: ModelPair
  task?: EvalTask
  prompt: string
  secondPrompt?: string
  think: boolean
  contextWindow: number
  tools?: readonly Tool[]
  permissions?: Record<string, 'always_allow'>
  excludedProcessRoots?: () => number[]
  limits: BenchmarkExecutionLimits
}): Promise<AgentCaseResult>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-mlx-benchmark-agent-'))
  const rawClient = await options.runtime.client(options.pair)
  const measuredClient = new MeasuredInferenceClient(
    rawClient,
    options.limits.maxOutputTokens
  )
  const counters = { calls: 0, errors: 0, agentErrors: 0 }
  let agent: Agent | undefined
  let runError: string | undefined
  const sampler = new ProcessTreeRssSampler(
    () => [process.pid, ...options.runtime.processRoots()],
    BENCHMARK_POLICY.rssSampleIntervalMs,
    options.excludedProcessRoots
  )
  let agentWallMs = 0
  let samples: Awaited<ReturnType<typeof sampler.stop>> = []
  try
  {
    await options.task?.setup(dir)
    agent = new Agent(options.runtime.model(options.pair), undefined, dir, {
      inferenceClient: measuredClient,
      maxIterations: 15,
      think: options.think,
      numCtx: options.contextWindow,
      verifyEdits: false,
      mcpMode: 'off',
      ...(options.tools ? { tools: options.tools } : {}),
      permissions: options.permissions ?? defaultToolPermissions(),
    })
    await sampler.start()
    const started = performance.now()
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      options.limits.requestTimeoutMs
    ).unref()
    try
    {
      await agent.run(options.prompt, eventSink(counters), controller.signal)
      if (options.secondPrompt)
      {
        await agent.run(
          options.secondPrompt,
          eventSink(counters),
          controller.signal
        )
      }
    }
    catch (error)
    {
      runError = error instanceof Error ? error.message : String(error)
    }
    finally
    {
      clearTimeout(timer)
      agentWallMs = performance.now() - started
      samples = await sampler.stop()
    }
    const finalText = latestAssistant(agent)
    let passed = !runError && counters.agentErrors === 0
    let detail =
      runError ??
      (counters.agentErrors === 0
        ? 'agent completed'
        : `agent emitted ${counters.agentErrors} error event(s)`)
    if (options.task)
    {
      const grade = await options.task.grade({
        dir,
        messages: agent.getMessages(),
        finalText,
      })
      passed &&= grade.passed
      detail =
        runError || counters.agentErrors > 0
          ? `${detail}; ${grade.detail}`
          : grade.detail
    }
    const measurements = measuredClient.takeMeasurements()
    return {
      passed,
      detail,
      finalText,
      toolEvidence: reliabilityEvidence(
        agent.getReliabilityStats(),
        measurements,
        counters.calls,
        counters.errors
      ),
      measurements,
      wallMs: agentWallMs,
      peakRssBytes: samples.reduce(
        (max, sample) => Math.max(max, sample.rssBytes),
        0
      ),
    }
  }
  finally
  {
    await agent?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

const probeCalls: Record<string, unknown>[] = []
const probeTool: Tool = {
  name: 'benchmark_probe',
  description:
    'Record one exact benchmark payload and return a fixed sentinel.',
  parameters: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      payload: {
        type: 'object',
        additionalProperties: true,
      },
    },
    required: ['label', 'payload'],
    additionalProperties: false,
  },
  async execute(args)
  {
    probeCalls.push(structuredClone(args))
    return { output: `${SENTINEL}:${String(args.label)}` }
  },
}

function exactArgs(
  calls: Record<string, unknown>[],
  expected: Record<string, unknown>[]
): boolean
{
  return JSON.stringify(calls) === JSON.stringify(expected)
}

function gradeEvidence(
  grade: Partial<ToolEvidence> & { passed: boolean; detail: string }
): Partial<ToolEvidence>
{
  return Object.fromEntries(
    Object.entries(grade).filter(
      ([key]) => key !== 'passed' && key !== 'detail'
    )
  ) as Partial<ToolEvidence>
}

const TOOL_CASES: readonly ToolCase[] = [
  {
    id: 'single-call',
    prompt:
      'Call benchmark_probe exactly once with label "single" and payload {"value":7}. Then answer done.',
    expectedCalls: 1,
    think: true,
    grade: (calls) => ({
      passed: exactArgs(calls, [{ label: 'single', payload: { value: 7 } }]),
      detail: 'single exact call',
      argumentsMatched: exactArgs(calls, [
        { label: 'single', payload: { value: 7 } },
      ]),
    }),
  },
  {
    id: 'parallel-calls',
    prompt:
      'In one assistant response, call benchmark_probe twice: first label "left" payload {"value":1}, then label "right" payload {"value":2}. Then answer done.',
    expectedCalls: 2,
    think: true,
    grade: (calls, _text, measurements) => ({
      passed:
        exactArgs(calls, [
          { label: 'left', payload: { value: 1 } },
          { label: 'right', payload: { value: 2 } },
        ]) && measurements.some((item) => item.toolCalls.length >= 2),
      detail: 'two exact calls in one response',
    }),
  },
  {
    id: 'nested-escaped-arguments',
    prompt:
      'Call benchmark_probe exactly once with label "nested" and payload {"quote":"a \\"quoted\\" value","nested":{"items":[1,{"ok":true}]}}. Then answer done.',
    expectedCalls: 1,
    think: true,
    grade: (calls) =>
    {
      const matched = exactArgs(calls, [
        {
          label: 'nested',
          payload: {
            quote: 'a "quoted" value',
            nested: { items: [1, { ok: true }] },
          },
        },
      ])
      return {
        passed: matched,
        detail: 'nested and escaped arguments matched',
        argumentsMatched: matched,
      }
    },
  },
  {
    id: 'reasoning-with-call',
    prompt:
      'Think about the number 8137, then call benchmark_probe once with label "reasoning" and payload {"value":8137}. Then answer done.',
    expectedCalls: 1,
    think: true,
    grade: (calls, _text, measurements) => ({
      passed:
        calls.length === 1 &&
        measurements.some((item) => item.reasoningWithToolCall),
      detail: 'reasoning and tool call both streamed',
      reasoningWithToolCall: measurements.some(
        (item) => item.reasoningWithToolCall
      ),
    }),
  },
  {
    id: 'text-with-call',
    prompt:
      'Write the word PRELUDE as normal answer text, and in the same assistant response call benchmark_probe once with label "text" and payload {"value":1}. Then answer done.',
    expectedCalls: 1,
    think: true,
    grade: (calls, _text, measurements) => ({
      passed:
        calls.length === 1 &&
        measurements.some((item) => item.textBeforeToolCall),
      detail: 'text preceded a tool call in one response',
      textBeforeToolCall: measurements.some((item) => item.textBeforeToolCall),
    }),
  },
  {
    id: 'prior-tool-result',
    prompt:
      'Call benchmark_probe once with label "prior" and payload {"value":8137}. Then answer done.',
    secondPrompt: `Read the prior tool result and reply with exactly ${SENTINEL}:prior`,
    expectedCalls: 1,
    think: true,
    grade: (calls, text) => ({
      passed: calls.length === 1 && text.trim() === `${SENTINEL}:prior`,
      detail: 'second turn used the prior tool result',
      priorToolResultUsed: text.trim() === `${SENTINEL}:prior`,
    }),
  },
  {
    id: 'thinking-disabled',
    prompt:
      'Call benchmark_probe once with label "no-think" and payload {"value":0}. Then answer done.',
    expectedCalls: 1,
    think: false,
    grade: (calls, _text, measurements) => ({
      passed:
        calls.length === 1 &&
        measurements.every((item) => item.thinkingChars === 0),
      detail: 'tool call completed without reasoning output',
    }),
  },
]

function observation(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  category: HardGateObservation['category'],
  caseId: string,
  repetition: number,
  sequence: number,
  result: AgentCaseResult,
  evidence?: ToolEvidence
): HardGateObservation
{
  return {
    topologyId: runtime.identity.id,
    modelPairId: pair.id,
    category,
    caseId,
    repetition,
    passed: result.passed,
    detail: result.detail,
    sequence,
    ...(evidence ? { toolEvidence: evidence } : {}),
  }
}

export async function runCorrectnessGates(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  sequenceStart: number,
  limits: BenchmarkExecutionLimits
): Promise<HardGateObservation[]>
{
  const rows: HardGateObservation[] = []
  let sequence = sequenceStart
  for (const task of TASKS)
  {
    for (let repetition = 1; repetition <= 5; repetition++)
    {
      const result = await runAgentCase({
        runtime,
        pair,
        task,
        prompt: task.prompt,
        think: true,
        contextWindow: Math.min(pair.ollama.contextWindow, 32_768),
        limits,
      })
      rows.push(
        observation(
          runtime,
          pair,
          'correctness',
          task.id,
          repetition,
          sequence++,
          result,
          result.toolEvidence
        )
      )
    }
  }
  return rows
}

export async function runToolGates(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  sequenceStart: number,
  limits: BenchmarkExecutionLimits
): Promise<HardGateObservation[]>
{
  const rows: HardGateObservation[] = []
  let sequence = sequenceStart
  for (const toolCase of TOOL_CASES)
  {
    for (let repetition = 1; repetition <= 5; repetition++)
    {
      probeCalls.splice(0)
      const result = await runAgentCase({
        runtime,
        pair,
        prompt: toolCase.prompt,
        secondPrompt: toolCase.secondPrompt,
        think: toolCase.think,
        contextWindow: Math.min(pair.ollama.contextWindow, 32_768),
        tools: [probeTool],
        permissions: { benchmark_probe: 'always_allow' },
        limits,
      })
      const grade = toolCase.grade(
        probeCalls,
        result.finalText,
        result.measurements
      )
      result.passed &&= grade.passed
      result.detail = grade.detail
      const evidence: ToolEvidence = {
        ...result.toolEvidence,
        expectedCalls: toolCase.expectedCalls,
        ...gradeEvidence(grade),
      }
      rows.push(
        observation(
          runtime,
          pair,
          'tool-semantics',
          toolCase.id,
          repetition,
          sequence++,
          result,
          evidence
        )
      )
    }
  }
  return rows
}

async function rawEcho(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  content: string,
  contextWindow: number,
  limits: BenchmarkExecutionLimits,
  secondPrompt?: string
): Promise<AgentCaseResult>
{
  return runAgentCase({
    runtime,
    pair,
    prompt: content,
    ...(secondPrompt ? { secondPrompt } : {}),
    think: false,
    contextWindow,
    tools: [],
    permissions: {},
    limits,
  })
}

function lifecycleObservation(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  caseId: string,
  repetition: number,
  sequence: number,
  passed: boolean,
  detail: string
): HardGateObservation
{
  return {
    topologyId: runtime.identity.id,
    modelPairId: pair.id,
    category: 'lifecycle',
    caseId,
    repetition,
    passed,
    detail,
    sequence,
  }
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<boolean>
{
  let timer: NodeJS.Timeout | undefined
  try
  {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) =>
      {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  }
  finally
  {
    if (timer) clearTimeout(timer)
  }
}

function aborts(signal: AbortSignal): Promise<void>
{
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true })
  )
}

async function cancelRequest(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  phase: 'prefill' | 'decode',
  limits: BenchmarkExecutionLimits
): Promise<boolean>
{
  const client = await runtime.client(pair)
  const controller = new AbortController()
  const request = client.chatStream(
    {
      model: runtime.model(pair),
      messages: [
        {
          role: 'user',
          content:
            phase === 'prefill'
              ? `${filler(16_000)}\nWrite ${SENTINEL} 200 times.`
              : `Write ${SENTINEL} 200 times.`,
        },
      ],
      think: false,
      num_ctx: Math.min(pair.ollama.contextWindow, 32_768),
      num_predict: limits.maxOutputTokens,
    },
    controller.signal
  )
  let deltaSeen = false
  const timer = setTimeout(
    () => controller.abort(),
    phase === 'prefill' ? 25 : limits.requestTimeoutMs
  ).unref()
  const consumption = (async () =>
  {
    try
    {
      for await (const chunk of request)
      {
        if (
          chunk.message.content ||
          chunk.message.thinking ||
          chunk.message.tool_calls?.length
        )
        {
          deltaSeen = true
          if (phase === 'decode') controller.abort()
        }
      }
    }
    catch
    {
      // an abort may reject the provider stream or end it without a final frame
    }
  })()
  const outcome = await Promise.race([
    consumption.then(() => 'settled' as const),
    aborts(controller.signal).then(() => 'aborted' as const),
  ])
  clearTimeout(timer)
  if (outcome !== 'aborted') return false
  const settled = await settlesWithin(
    consumption,
    Math.min(limits.requestTimeoutMs, 5_000)
  )
  if (!settled)
  {
    await runtime.resetModel(pair)
    await settlesWithin(consumption, 5_000)
  }
  return settled && (phase === 'prefill' || deltaSeen)
}

async function timeoutRequest(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  limits: BenchmarkExecutionLimits
): Promise<boolean>
{
  const client = await runtime.client(pair)
  const signal = AbortSignal.timeout(25)
  const consumption = (async () =>
  {
    try
    {
      for await (const chunk of client.chatStream(
        {
          model: runtime.model(pair),
          messages: [
            {
              role: 'user',
              content: `${filler(16_000)}\nWrite ${SENTINEL} 200 times.`,
            },
          ],
          think: false,
          num_ctx: Math.min(pair.ollama.contextWindow, 32_768),
          num_predict: limits.maxOutputTokens,
        },
        signal
      ))
      {
        if (chunk.done) break
      }
    }
    catch
    {
      // the deadline may reject the stream or retire it without a final frame
    }
  })()
  const outcome = await Promise.race([
    consumption.then(() => 'settled' as const),
    aborts(signal).then(() => 'aborted' as const),
  ])
  if (outcome !== 'aborted') return false
  const settled = await settlesWithin(
    consumption,
    Math.min(limits.requestTimeoutMs, 5_000)
  )
  if (!settled)
  {
    await runtime.resetModel(pair)
    await settlesWithin(consumption, 5_000)
  }
  return settled && signal.reason?.name === 'TimeoutError'
}

function longDecode(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  limits: BenchmarkExecutionLimits
): { firstDelta: Promise<boolean>; settled: Promise<void> }
{
  let resolveFirst!: (seen: boolean) => void
  const firstDelta = new Promise<boolean>((resolve) =>
  {
    resolveFirst = resolve
  })
  const settled = (async () =>
  {
    let seen = false
    try
    {
      const client = await runtime.client(pair)
      for await (const chunk of client.chatStream({
        model: runtime.model(pair),
        messages: [{ role: 'user', content: `Write ${SENTINEL} 500 times.` }],
        think: false,
        num_ctx: Math.min(pair.ollama.contextWindow, 32_768),
        num_predict: limits.maxOutputTokens,
      }))
      {
        if (
          !seen &&
          (chunk.message.content ||
            chunk.message.thinking ||
            chunk.message.tool_calls?.length)
        )
        {
          seen = true
          resolveFirst(true)
        }
      }
    }
    catch
    {
      // stopping the owned runtime is expected to reject the active stream
    }
    finally
    {
      if (!seen) resolveFirst(false)
    }
  })()
  return { firstDelta, settled }
}

export async function runLifecycleGates(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  sequenceStart: number,
  limits: BenchmarkExecutionLimits
): Promise<HardGateObservation[]>
{
  const rows: HardGateObservation[] = []
  let sequence = sequenceStart
  const recoveryLimits = {
    ...limits,
    requestTimeoutMs: Math.min(
      limits.requestTimeoutMs,
      LIFECYCLE_PROBE_TIMEOUT_MS
    ),
  }
  for (let repetition = 1; repetition <= 3; repetition++)
  {
    const prefillCancelled = await cancelRequest(
      runtime,
      pair,
      'prefill',
      recoveryLimits
    )
    rows.push(
      lifecycleObservation(
        runtime,
        pair,
        'cancel-prefill',
        repetition,
        sequence++,
        prefillCancelled,
        prefillCancelled ? 'prefill cancelled' : 'prefill did not cancel'
      )
    )
    const decodeCancelled = await cancelRequest(
      runtime,
      pair,
      'decode',
      recoveryLimits
    )
    rows.push(
      lifecycleObservation(
        runtime,
        pair,
        'cancel-decode',
        repetition,
        sequence++,
        decodeCancelled,
        decodeCancelled ? 'decode cancelled' : 'decode did not cancel'
      )
    )
    const afterCancel = await rawEcho(
      runtime,
      pair,
      `Reply with exactly ${SENTINEL}`,
      Math.min(pair.ollama.contextWindow, 32_768),
      recoveryLimits
    )
    const recovered =
      afterCancel.passed && afterCancel.finalText.includes(SENTINEL)
    rows.push(
      lifecycleObservation(
        runtime,
        pair,
        'next-request-after-cancel',
        repetition,
        sequence++,
        recovered,
        recovered
          ? `next request succeeded within ${recoveryLimits.requestTimeoutMs} ms`
          : `next request failed within ${recoveryLimits.requestTimeoutMs} ms`
      )
    )

    if (runtime.identity.role !== 'candidate') continue
    let crashRecovered = false
    let crashDetail = 'restart was not attempted'
    try
    {
      await runtime.crashAndRestart(pair)
      const afterCrash = await rawEcho(
        runtime,
        pair,
        `Reply with exactly ${SENTINEL}`,
        Math.min(pair.ollama.contextWindow, 32_768),
        limits
      )
      crashRecovered =
        afterCrash.passed && afterCrash.finalText.includes(SENTINEL)
      crashDetail = crashRecovered
        ? 'one crash restarted cleanly'
        : 'request after restart failed'
    }
    catch (error)
    {
      crashDetail = error instanceof Error ? error.message : String(error)
    }
    rows.push(
      lifecycleObservation(
        runtime,
        pair,
        'crash-restart-once',
        repetition,
        sequence++,
        crashRecovered,
        crashDetail
      )
    )

    const timedOut = await timeoutRequest(runtime, pair, recoveryLimits)
    const afterTimeout = await rawEcho(
      runtime,
      pair,
      `Reply with exactly ${SENTINEL}`,
      Math.min(pair.ollama.contextWindow, 32_768),
      recoveryLimits
    )
    const timeoutRecovered =
      timedOut &&
      afterTimeout.passed &&
      afterTimeout.finalText.includes(SENTINEL)
    rows.push(
      lifecycleObservation(
        runtime,
        pair,
        'timeout-recovery',
        repetition,
        sequence++,
        timeoutRecovered,
        timeoutRecovered
          ? `bounded timeout recovered within ${recoveryLimits.requestTimeoutMs} ms without an OOM injection`
          : `request after bounded timeout failed within ${recoveryLimits.requestTimeoutMs} ms`
      )
    )

    const active = longDecode(runtime, pair, limits)
    const deltaBeforeQuit = await Promise.race([
      active.firstDelta,
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), limits.requestTimeoutMs).unref()
      ),
    ])
    const shutdown = await runtime.stop()
    const streamSettled = await Promise.race([
      active.settled.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 5_000).unref()
      ),
    ])
    const cleanQuit = deltaBeforeQuit && shutdown.allExited && streamSettled
    rows.push(
      lifecycleObservation(
        runtime,
        pair,
        'quit-no-descendants',
        repetition,
        sequence++,
        cleanQuit,
        cleanQuit
          ? `${shutdown.descendants.length} owned pids retired mid-generation`
          : `mid-generation quit failed; tracked pids: ${shutdown.descendants.join(', ')}`
      )
    )
    await runtime.start(pair)
  }
  return rows
}

export async function runSameModelResidencyGate(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  sequenceStart: number,
  limits: BenchmarkExecutionLimits
): Promise<HardGateObservation[]>
{
  const rows: HardGateObservation[] = []
  for (let repetition = 1; repetition <= 3; repetition++)
  {
    const rootsBefore = runtime.processRoots().join(',')
    const first = await rawEcho(
      runtime,
      pair,
      `Reply with exactly ${SENTINEL}`,
      Math.min(pair.ollama.contextWindow, 32_768),
      limits
    )
    const afterFirst = await memorySnapshot(runtime, 'after-first-request')
    const second = await rawEcho(
      runtime,
      pair,
      `Reply with exactly ${SENTINEL}`,
      Math.min(pair.ollama.contextWindow, 32_768),
      limits
    )
    const afterSecond = await memorySnapshot(runtime, 'after-second-request')
    const rootsAfter = runtime.processRoots().join(',')
    const directResidency =
      runtime.identity.kind !== 'stock-mlx' ||
      (afterFirst.mlxAllocatorActiveBytes !== undefined &&
        afterFirst.mlxAllocatorActiveBytes > 0 &&
        afterFirst.mlxModelIdentity === runtime.model(pair) &&
        afterSecond.mlxAllocatorActiveBytes !== undefined &&
        afterSecond.mlxAllocatorActiveBytes > 0 &&
        afterSecond.mlxModelIdentity === runtime.model(pair))
    const passed =
      first.passed &&
      second.passed &&
      first.finalText.includes(SENTINEL) &&
      second.finalText.includes(SENTINEL) &&
      directResidency &&
      rootsBefore === rootsAfter
    rows.push({
      topologyId: runtime.identity.id,
      modelPairId: pair.id,
      category: 'residency',
      caseId: 'same-model-reuse',
      repetition,
      passed,
      detail: passed ? 'same model and process roots reused' : 'reuse failed',
      sequence: sequenceStart + repetition - 1,
      memorySnapshots: [afterFirst, afterSecond],
    })
  }
  return rows
}

export async function runCrossRuntimeResidencyGate(
  candidate: BenchmarkRuntime,
  baseline: BenchmarkRuntime,
  pair: ModelPair,
  sequenceStart: number,
  limits: BenchmarkExecutionLimits
): Promise<HardGateObservation[]>
{
  const rows: HardGateObservation[] = []
  for (let repetition = 1; repetition <= 3; repetition++)
  {
    const directFirst = await rawEcho(
      candidate,
      pair,
      `Reply with exactly ${SENTINEL}`,
      Math.min(pair.ollama.contextWindow, 32_768),
      limits
    )
    const afterDirectFirst = await memorySnapshot(
      candidate,
      'after-direct-first'
    )
    const unloaded = await candidate.stop()
    const afterDirectUnload = await memorySnapshot(
      candidate,
      'after-direct-unload',
      false
    )
    const ollama = await rawEcho(
      baseline,
      pair,
      `Reply with exactly ${SENTINEL}`,
      Math.min(pair.ollama.contextWindow, 32_768),
      limits
    )
    const afterOllama = await memorySnapshot(baseline, 'after-ollama')
    await baseline.resetModel(pair)
    const afterOllamaUnload = await memorySnapshot(
      baseline,
      'after-ollama-unload',
      false
    )
    const ollamaUnloaded =
      afterOllamaUnload.processTreeRssBytes < afterOllama.processTreeRssBytes
    await candidate.start(pair)
    const directSecond = await rawEcho(
      candidate,
      pair,
      `Reply with exactly ${SENTINEL}`,
      Math.min(pair.ollama.contextWindow, 32_768),
      limits
    )
    const afterDirectSecond = await memorySnapshot(
      candidate,
      'after-direct-second'
    )
    const directResidency =
      candidate.identity.kind !== 'stock-mlx' ||
      (afterDirectFirst.mlxAllocatorActiveBytes !== undefined &&
        afterDirectFirst.mlxAllocatorActiveBytes > 0 &&
        afterDirectFirst.mlxModelIdentity === candidate.model(pair) &&
        afterDirectSecond.mlxAllocatorActiveBytes !== undefined &&
        afterDirectSecond.mlxAllocatorActiveBytes > 0 &&
        afterDirectSecond.mlxModelIdentity === candidate.model(pair))
    const passed =
      directFirst.passed &&
      unloaded.allExited &&
      ollama.passed &&
      ollamaUnloaded &&
      directSecond.passed &&
      directResidency &&
      directFirst.finalText.includes(SENTINEL) &&
      ollama.finalText.includes(SENTINEL) &&
      directSecond.finalText.includes(SENTINEL)
    rows.push({
      topologyId: candidate.identity.id,
      modelPairId: pair.id,
      category: 'residency',
      caseId: 'direct-mlx-ollama-direct-mlx',
      repetition,
      passed,
      detail: passed
        ? 'direct MLX and Ollama unloaded before direct MLX restarted cleanly'
        : 'cross-runtime switch or unload failed',
      sequence: sequenceStart + repetition - 1,
      memorySnapshots: [
        afterDirectFirst,
        afterDirectUnload,
        afterOllama,
        afterOllamaUnload,
        afterDirectSecond,
      ],
    })
  }
  return rows
}

function filler(tokens: number): string
{
  return ' x'.repeat(tokens)
}

interface CalibratedPrompt
{
  prompt: string
  promptTokens: number
}

async function calibratePrompt(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  targetTokens: number,
  contextWindow: number,
  limits: BenchmarkExecutionLimits,
  buildPrompt: (repetitions: number) => string
): Promise<CalibratedPrompt>
{
  let low = 0
  let high = targetTokens
  let best: CalibratedPrompt | undefined
  try
  {
    while (low <= high)
    {
      const repetitions = Math.floor((low + high) / 2)
      const prompt = buildPrompt(repetitions)
      const result = await runAgentCase({
        runtime,
        pair,
        prompt,
        think: false,
        contextWindow,
        tools: [],
        permissions: {},
        limits,
      })
      const promptTokens = result.measurements[0]?.promptTokens ?? 0
      if (promptTokens <= 0)
      {
        throw new Error('prompt calibration returned no token count')
      }
      if (promptTokens >= targetTokens)
      {
        if (promptTokens <= contextWindow) best = { prompt, promptTokens }
        high = repetitions - 1
      }
      else
      {
        low = repetitions + 1
      }
    }
  }
  finally
  {
    await runtime.resetModel(pair)
  }
  if (!best)
  {
    throw new Error(
      `could not calibrate ${targetTokens} actual prompt tokens within ` +
        `${contextWindow} tokens without a download`
    )
  }
  return best
}

function longContextTarget(
  contextCeiling: number,
  maxOutputTokens: number
): number
{
  const reserve = Math.min(
    maxOutputTokens,
    Math.max(512, Math.floor(contextCeiling / 4))
  )
  return Math.max(1, Math.min(32_000, contextCeiling - reserve - 512))
}

async function memorySnapshot(
  runtime: BenchmarkRuntime,
  stage: string,
  includeAllocator = true
): Promise<ResidencyMemorySnapshot>
{
  const rss = await processTreeRss([process.pid, ...runtime.processRoots()])
  const allocator = includeAllocator
    ? await runtime.allocatorMemory()
    : undefined
  return {
    stage,
    processTreeRssBytes: rss.rssBytes,
    ...(allocator
      ? {
          mlxAllocatorActiveBytes: allocator.activeBytes,
          mlxAllocatorCacheBytes: allocator.cacheBytes,
          mlxAllocatorPeakBytes: allocator.peakBytes,
          ...(allocator.modelIdentity
            ? { mlxModelIdentity: allocator.modelIdentity }
            : {}),
        }
      : {}),
  }
}

export async function runContextGates(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  contextCeiling: number,
  sequenceStart: number,
  limits: BenchmarkExecutionLimits
): Promise<HardGateObservation[]>
{
  const resolvedLongTarget = longContextTarget(
    contextCeiling,
    limits.maxOutputTokens
  )
  const eightKTarget = Math.min(8_000, resolvedLongTarget)
  const definitions = [
    {
      id: 'short',
      tokens: 0,
      prompt: `Reply with exactly ${SENTINEL}`,
    },
    {
      id: '8k',
      targetTokens: eightKTarget,
      buildPrompt: (repetitions: number) =>
        `${SENTINEL}\n${filler(repetitions)}\nReply with exactly ${SENTINEL}`,
    },
    {
      id: '32k-or-ceiling',
      targetTokens: resolvedLongTarget,
      buildPrompt: (repetitions: number) =>
        `${SENTINEL}\n${filler(repetitions)}\nReply with exactly ${SENTINEL}`,
    },
    {
      id: 'repeated-prefix',
      targetTokens: eightKTarget,
      buildPrompt: (repetitions: number) =>
        `${filler(repetitions)}\nRemember ${SENTINEL} and answer READY`,
      secondPrompt: `Reply with exactly ${SENTINEL}`,
    },
    {
      id: 'multi-round-agent',
      tokens: 0,
      prompt: `Remember ${SENTINEL} and answer READY`,
      secondPrompt: `Reply with exactly ${SENTINEL}`,
    },
  ]

  const rows: HardGateObservation[] = []
  let sequence = sequenceStart
  for (const definition of definitions)
  {
    const contextWindow = Math.min(pair.ollama.contextWindow, contextCeiling)
    const calibrated = definition.buildPrompt
      ? await calibratePrompt(
          runtime,
          pair,
          definition.targetTokens,
          contextWindow,
          limits,
          definition.buildPrompt
        )
      : undefined
    const prompt = calibrated?.prompt ?? definition.prompt
    if (!prompt) throw new Error(`context case ${definition.id} has no prompt`)
    for (let repetition = 1; repetition <= 5; repetition++)
    {
      const result = await rawEcho(
        runtime,
        pair,
        prompt,
        contextWindow,
        limits,
        definition.secondPrompt
      )
      const promptTokens =
        result.measurements[definition.secondPrompt ? 1 : 0]?.promptTokens ?? 0
      result.passed &&=
        result.finalText.includes(SENTINEL) &&
        promptTokens > 0 &&
        promptTokens <= contextWindow &&
        (definition.targetTokens === undefined ||
          promptTokens >= definition.targetTokens)
      result.detail = result.passed
        ? `${definition.id} retained sentinel at ${promptTokens} prompt tokens`
        : `${definition.id} failed at ${promptTokens} prompt tokens`
      const row = observation(
        runtime,
        pair,
        'context',
        definition.id,
        repetition,
        sequence++,
        result
      )
      if (promptTokens > 0) row.promptTokens = promptTokens
      rows.push(row)
    }
  }
  return rows
}

export interface PreparedPerformancePrompt
{
  prompt: string
  secondPrompt?: string
  minimumPromptTokens?: number
  measuredRequestIndex: number
}

export async function preparePerformanceWorkload(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  workloadId: string,
  contextCeiling: number,
  limits: BenchmarkExecutionLimits
): Promise<PreparedPerformancePrompt>
{
  const contextWindow = Math.min(pair.ollama.contextWindow, contextCeiling)
  if (workloadId === 'long-context')
  {
    const calibrated = await calibratePrompt(
      runtime,
      pair,
      Math.min(
        8_000,
        longContextTarget(contextCeiling, limits.maxOutputTokens)
      ),
      contextWindow,
      limits,
      (repetitions) =>
        `${SENTINEL}\n${filler(repetitions)}\nReply with exactly ${SENTINEL}`
    )
    return {
      prompt: calibrated.prompt,
      minimumPromptTokens: Math.min(
        8_000,
        longContextTarget(contextCeiling, limits.maxOutputTokens)
      ),
      measuredRequestIndex: 0,
    }
  }
  if (workloadId === 'repeated-prefix')
  {
    const target = Math.min(
      8_000,
      longContextTarget(contextCeiling, limits.maxOutputTokens)
    )
    const calibrated = await calibratePrompt(
      runtime,
      pair,
      target,
      contextWindow,
      limits,
      (repetitions) =>
        `${filler(repetitions)}\nRemember ${SENTINEL} and answer READY`
    )
    return {
      prompt: calibrated.prompt,
      secondPrompt: `Using the prior prefix, reply with exactly ${SENTINEL}`,
      minimumPromptTokens: target,
      measuredRequestIndex: 1,
    }
  }
  return {
    prompt:
      workloadId === 'short-code'
        ? TASKS[5]!.prompt
        : `Reply with exactly ${SENTINEL}`,
    measuredRequestIndex: 0,
  }
}

export async function measurePerformanceWorkload(
  runtime: BenchmarkRuntime,
  pair: ModelPair,
  workloadId: string,
  cold: boolean,
  contextCeiling: number,
  limits: BenchmarkExecutionLimits,
  prepared: PreparedPerformancePrompt,
  unloadedRssBytes?: number,
  excludedProcessRoots: () => number[] = () => []
): Promise<MetricVector>
{
  let baselineRss = unloadedRssBytes
  if (cold)
  {
    await runtime.resetModel(pair)
    baselineRss = (
      await processTreeRss(
        [process.pid, ...runtime.processRoots()],
        excludedProcessRoots()
      )
    ).rssBytes
  }
  if (baselineRss === undefined)
  {
    throw new Error('performance workload requires an unloaded RSS baseline')
  }
  const task = workloadId === 'short-code' ? TASKS[5] : undefined
  await runtime.allocatorMemory(true)
  const result = await runAgentCase({
    runtime,
    pair,
    task,
    prompt: prepared.prompt,
    ...(prepared.secondPrompt ? { secondPrompt: prepared.secondPrompt } : {}),
    think: false,
    contextWindow: Math.min(pair.ollama.contextWindow, contextCeiling),
    ...(task ? {} : { tools: [] as readonly Tool[], permissions: {} }),
    excludedProcessRoots,
    limits,
  })
  if (!result.passed || (!task && !result.finalText.includes(SENTINEL)))
  {
    throw new Error(
      `performance workload ${workloadId} was not correct: ${result.detail}`
    )
  }
  const measured = result.measurements[prepared.measuredRequestIndex]
  if (
    !measured ||
    (prepared.minimumPromptTokens !== undefined &&
      measured.promptTokens < prepared.minimumPromptTokens)
  )
  {
    throw new Error(
      `performance workload ${workloadId} did not reach its calibrated prompt size`
    )
  }
  const metrics = requestMetrics(
    result.measurements,
    prepared.measuredRequestIndex
  )
  const allocator = await runtime.allocatorMemory()
  const peakRssAboveBaselineBytes = result.peakRssBytes - baselineRss
  if (peakRssAboveBaselineBytes <= 0)
  {
    throw new Error(
      `performance workload ${workloadId} did not rise above its unloaded RSS baseline`
    )
  }
  return {
    ...(cold
      ? { coldFirstDeltaMs: metrics.firstDeltaMs }
      : { warmTtftMs: metrics.firstDeltaMs }),
    promptTokensPerSecond: metrics.promptTokensPerSecond,
    decodeTokensPerSecond: metrics.decodeTokensPerSecond,
    agentWallMs: result.wallMs,
    peakRssAboveBaselineBytes,
    unloadedRssBytes: baselineRss,
    peakAbsoluteRssBytes: result.peakRssBytes,
    ...(allocator
      ? {
          mlxAllocatorActiveBytes: allocator.activeBytes,
          mlxAllocatorCacheBytes: allocator.cacheBytes,
          mlxAllocatorPeakBytes: allocator.peakBytes,
        }
      : {}),
  }
}
