// tests/scripts/bench-compaction.ts
// compare bounded Git-context layouts through the real Ollama transport

import { randomBytes } from 'node:crypto'
import { OllamaClient } from '../../src/ollama/client.js'
import { normalizeOllamaHost } from '../../src/ollama/host.js'
import { estimateModelRequestMessagesTokens } from '../../src/agent/request/projection.js'
import type { ChatResponse, OllamaMessage } from '../../src/types/inference.js'

const NUM_CTX = 8192
const NUM_PREDICT = 16
const REPETITIONS = 4
type Layout = 'system' | 'user'

interface Sample
{
  wire: string
  promptTokens: number
  promptMs: number
  firstContentMs: number
  generatedTokens: number
  loadMs: number
}

interface Pair
{
  repetition: number
  layout: Layout
  prime: Sample
  changed: Sample
  commonPrefixBytes: number
}

// keep a frozen-summary-shaped prefix and change only the final Git observation
function buildHistory(
  trial: string,
  layout: Layout,
  change: number
): OllamaMessage[]
{
  const messages: OllamaMessage[] = [
    {
      role: 'system',
      content: `You are Coral, a local coding assistant. Synthetic trial ${trial}. Reply to the final task with just OK.`,
    },
    {
      role: 'user',
      content:
        '[Conversation handoff]\n' +
        'Earlier work preserved cancellation, revision checks, and existing file ownership. '.repeat(
          14
        ),
    },
    { role: 'assistant', content: 'I will preserve those constraints.' },
  ]
  for (let index = 0; index < 12; index++)
  {
    messages.push(
      {
        role: 'user',
        content:
          `Review item ${index}: ` +
          'Trace the current request and retain the established state owner. '.repeat(
            7
          ),
      },
      {
        role: 'assistant',
        content:
          `Item ${index}: ` +
          'The request follows the existing owner and preserves its cancellation boundary. '.repeat(
            7
          ),
      }
    )
  }
  messages.push(
    { role: 'user', content: 'Reply with just: OK' },
    {
      role: layout,
      content: `## Git Context\n- root: /synthetic/coral\n- branch: main\n- status: dirty (${change} unstaged)\n- unstaged: src/example.ts`,
    }
  )
  return messages
}

// capture the actual fetch projection without introducing a production seam
async function measure(
  client: OllamaClient,
  model: string,
  messages: OllamaMessage[],
  signal: AbortSignal
): Promise<Sample>
{
  if (estimateModelRequestMessagesTokens(messages) >= 5000)
  {
    throw new Error('Synthetic request exceeds the 5,000-token estimate cap')
  }
  const originalFetch = globalThis.fetch
  const wires: string[] = []
  let firstContentMs: number | undefined
  let done: (ChatResponse & { load_duration?: number }) | undefined
  const start = performance.now()
  globalThis.fetch = async (input, init) =>
  {
    if (typeof init?.body === 'string')
    {
      const body = JSON.parse(init.body) as {
        messages?: unknown
        think?: unknown
        options?: { num_ctx?: number; num_predict?: number }
      }
      if (
        body.think !== false ||
        body.options?.num_ctx !== NUM_CTX ||
        body.options.num_predict !== NUM_PREDICT
      )
      {
        throw new Error('Benchmark wire options changed')
      }
      wires.push(JSON.stringify(body.messages))
    }
    return originalFetch(input, init)
  }
  try
  {
    for await (const chunk of client.chatStream(
      {
        model,
        messages,
        think: false,
        keep_alive: '2m',
        num_ctx: NUM_CTX,
        num_predict: NUM_PREDICT,
      },
      signal
    ))
    {
      if (chunk.message?.content && firstContentMs === undefined)
      {
        firstContentMs = performance.now() - start
      }
      if (chunk.done) done = chunk
    }
    signal.throwIfAborted()
  }
  finally
  {
    globalThis.fetch = originalFetch
  }
  if (
    wires.length !== 1 ||
    firstContentMs === undefined ||
    !done ||
    !Number.isFinite(done.prompt_eval_duration) ||
    done.prompt_eval_duration! <= 0 ||
    !Number.isFinite(done.prompt_eval_count) ||
    done.prompt_eval_count! <= 0 ||
    done.prompt_eval_count! >= NUM_CTX - NUM_PREDICT ||
    !Number.isFinite(done.eval_count) ||
    done.eval_count! <= 0 ||
    done.eval_count! > NUM_PREDICT ||
    !Number.isFinite(done.load_duration) ||
    done.load_duration! < 0
  )
  {
    throw new Error(
      'Incomplete or invalid benchmark metrics; no layout verdict'
    )
  }
  return {
    wire: wires[0]!,
    promptTokens: done.prompt_eval_count!,
    promptMs: done.prompt_eval_duration! / 1e6,
    firstContentMs,
    generatedTokens: done.eval_count!,
    loadMs: done.load_duration! / 1e6,
  }
}

function commonPrefixBytes(left: string, right: string): number
{
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  let index = 0
  while (index < a.length && index < b.length && a[index] === b[index]) index++
  return index
}

function median(values: number[]): number
{
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

async function runningModels(
  host: string,
  signal: AbortSignal
): Promise<{ name: string; digest: string }[]>
{
  const response = await fetch(`${host}/api/ps`, { signal })
  if (!response.ok) throw new Error(`Ollama /api/ps failed: ${response.status}`)
  const body = (await response.json()) as {
    models?: { name: string; digest: string }[]
  }
  if (
    !Array.isArray(body.models) ||
    body.models.some(
      (model) =>
        typeof model.name !== 'string' || typeof model.digest !== 'string'
    )
  )
  {
    throw new Error('Ollama /api/ps did not return model identities')
  }
  return body.models
}

// restore only the benchmark-owned model with an independent bounded deadline
async function unloadBenchmarkModel(
  client: OllamaClient,
  model: string,
  host: string,
  digest: string
): Promise<void>
{
  const cleanupSignal = AbortSignal.timeout(30_000)
  const originalFetch = globalThis.fetch
  try
  {
    const current = await client.resolveModelArtifact(model, cleanupSignal)
    if (current.digest !== digest)
      throw new Error(
        'Model identity changed; refusing to evict a different artifact'
      )
    globalThis.fetch = (input, init) =>
      originalFetch(input, {
        ...init,
        signal: AbortSignal.any([
          cleanupSignal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      })
    await client.evictModel(model)
    const remaining = await runningModels(host, cleanupSignal)
    if (
      remaining.some(
        (entry) =>
          entry.digest.replace(/^sha256:/, '') ===
          digest?.replace(/^sha256:/, '')
      )
    )
    {
      throw new Error('Benchmark model remained loaded after cleanup')
    }
    console.log(
      JSON.stringify({
        cleanup: 'benchmark model unloaded',
        remainingModels: remaining.map((entry) => entry.name),
      })
    )
  }
  finally
  {
    globalThis.fetch = originalFetch
  }
}

async function main(): Promise<void>
{
  const model = process.argv[2]
  if (!model)
    throw new Error('usage: npm run bench:compaction -- <model> [host]')
  const host = normalizeOllamaHost(process.argv[3] ?? 'http://localhost:11434')
  const client = new OllamaClient(host)
  const controller = new AbortController()
  const interrupt = (): void =>
    controller.abort(new Error('Benchmark interrupted'))
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const overall = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(8 * 60_000),
  ])
  const requestSignal = (timeout: number): AbortSignal =>
    AbortSignal.any([overall, AbortSignal.timeout(timeout)])
  let loadedByBenchmark = false
  let digest: string | undefined
  const pairs: Pair[] = []
  try
  {
    const artifact = await client.resolveModelArtifact(
      model,
      requestSignal(10_000)
    )
    digest = artifact.digest
    if ((await runningModels(host, requestSignal(10_000))).length)
    {
      throw new Error(
        'A model is already running; benchmark deferred without eviction'
      )
    }
    console.log(
      JSON.stringify({
        model,
        host,
        digest,
        num_ctx: NUM_CTX,
        num_predict: NUM_PREDICT,
        think: false,
        repetitions: REPETITIONS,
      })
    )
    loadedByBenchmark = true
    const warmup = await measure(
      client,
      model,
      [{ role: 'user', content: 'Reply with just: OK' }],
      requestSignal(120_000)
    )
    console.log(
      JSON.stringify({ warmup: { ...warmup, wire: undefined }, excluded: true })
    )
    const runId = randomBytes(4).toString('hex')
    for (let repetition = 0; repetition < REPETITIONS; repetition++)
    {
      const layouts: Layout[] =
        repetition % 2 ? ['user', 'system'] : ['system', 'user']
      for (const layout of layouts)
      {
        const current = await client.resolveModelArtifact(
          model,
          requestSignal(10_000)
        )
        const running = await runningModels(host, requestSignal(10_000))
        if (
          current.digest !== digest ||
          running.length !== 1 ||
          running[0]!.digest.replace(/^sha256:/, '') !==
            digest.replace(/^sha256:/, '')
        )
        {
          throw new Error(
            'Model identity or exclusive residency changed; no layout verdict'
          )
        }
        const trial = `${runId}-${repetition}-${layout === 'system' ? 's' : 'u'}`
        const prime = await measure(
          client,
          model,
          buildHistory(trial, layout, 1),
          requestSignal(60_000)
        )
        const changed = await measure(
          client,
          model,
          buildHistory(trial, layout, 2),
          requestSignal(60_000)
        )
        const pair = {
          repetition,
          layout,
          prime,
          changed,
          commonPrefixBytes: commonPrefixBytes(prime.wire, changed.wire),
        }
        pairs.push(pair)
        console.log(
          JSON.stringify({
            ...pair,
            prime: { ...prime, wire: undefined },
            changed: { ...changed, wire: undefined },
            wireBytes: Buffer.byteLength(changed.wire),
          })
        )
      }
    }
    const finalRunning = await runningModels(host, requestSignal(10_000))
    if (
      (await client.resolveModelArtifact(model, requestSignal(10_000)))
        .digest !== digest ||
      finalRunning.length !== 1 ||
      finalRunning[0]!.digest.replace(/^sha256:/, '') !==
        digest.replace(/^sha256:/, '')
    )
    {
      throw new Error(
        'Model identity or exclusive residency changed during the final pair; no layout verdict'
      )
    }
    const systems = pairs.filter((pair) => pair.layout === 'system')
    const users = pairs.filter((pair) => pair.layout === 'user')
    const beforeMs = median(systems.map((pair) => pair.changed.promptMs))
    const afterMs = median(users.map((pair) => pair.changed.promptMs))
    const beforeFirstMs = median(
      systems.map((pair) => pair.changed.firstContentMs)
    )
    const afterFirstMs = median(
      users.map((pair) => pair.changed.firstContentMs)
    )
    const wins = users.filter(
      (pair, index) => pair.changed.promptMs < systems[index]!.changed.promptMs
    ).length
    const passes =
      beforeMs - afterMs >= 20 &&
      afterMs <= beforeMs * 0.8 &&
      wins >= 3 &&
      afterFirstMs <= beforeFirstMs * 1.1
    console.log(
      JSON.stringify({
        verdict: passes
          ? 'adopt trailing-user Git observation'
          : 'retain current layout',
        beforeMs,
        afterMs,
        gainMs: beforeMs - afterMs,
        gainPercent: (1 - afterMs / beforeMs) * 100,
        wins,
        beforeFirstMs,
        afterFirstMs,
      })
    )
    console.log(
      'prompt_eval_count is total prompt accounting, not uncached tokens; this verdict applies only to this model and fixture.'
    )
  }
  finally
  {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    if (loadedByBenchmark)
    {
      await unloadBenchmarkModel(client, model, host, digest!)
    }
  }
}

void main().catch((error: unknown) =>
{
  console.error(error)
  process.exitCode = 1
})
