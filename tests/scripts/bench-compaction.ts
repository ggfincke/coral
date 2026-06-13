// tests/scripts/bench-compaction.ts
// measures Ollama KV-cache reuse to validate cache-friendly compaction
// usage: npm run bench:compaction -- <model> [host]

import { OllamaClient } from '../../src/ollama/client.js'
import type { OllamaMessage } from '../../src/types/inference.js'

// pinned context window for the run — held constant so the runner isn't reloaded
const BENCH_NUM_CTX = 8192

// build a synthetic conversation large enough that prefill is clearly measurable
function buildHistory(turns: number): OllamaMessage[]
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'You are Coral, a local coding assistant.' },
  ]

  for (let i = 0; i < turns; i++)
  {
    messages.push({
      role: 'user',
      content: `Question ${i + 1}: ${'explain this code path in detail. '.repeat(8)}`,
    })
    messages.push({
      role: 'assistant',
      content: `Answer ${i + 1}: ${'here is the relevant explanation. '.repeat(8)}`,
    })
  }

  return messages
}

// send one request & return the prefill cost. note: prompt_eval_count reports
// the TOTAL prompt tokens regardless of caching — the cache hit shows up in
// prompt_eval_duration (the time actually spent prefilling), so that is the
// signal we measure
async function measurePrefill(
  client: OllamaClient,
  model: string,
  messages: OllamaMessage[]
): Promise<{ tokens: number; ms: number }>
{
  let tokens = 0
  let ms = 0

  for await (const chunk of client.chatStream({
    model,
    messages: [...messages, { role: 'user', content: 'Reply with just: OK' }],
    num_ctx: BENCH_NUM_CTX,
  }))
  {
    if (chunk.done)
    {
      tokens = chunk.prompt_eval_count ?? 0
      ms = (chunk.prompt_eval_duration ?? 0) / 1e6
    }
  }

  return { tokens, ms }
}

async function main(): Promise<void>
{
  const model = process.argv[2]
  const host = process.argv[3] ?? 'http://localhost:11434'

  if (!model)
  {
    console.error('usage: npm run bench:compaction -- <model> [host]')
    process.exit(1)
  }

  const client = new OllamaClient(host)
  const base = buildHistory(40)

  console.log(`model: ${model}`)
  console.log(`host:  ${host}`)
  console.log(`num_ctx pinned at ${BENCH_NUM_CTX}\n`)

  // cold — first call warms the slot, full prefill
  const cold = await measurePrefill(client, model, base)

  // append-only growth — what cache-friendly compaction does to the live tail.
  // the shared prefix is cached from the cold call, so only the appended turn
  // should actually prefill (small duration) if the model reuses its cache
  const grown: OllamaMessage[] = [
    ...base,
    { role: 'assistant', content: 'Acknowledged.' },
    {
      role: 'user',
      content: 'One more follow-up question to extend the tail.',
    },
  ]
  const warm = await measurePrefill(client, model, grown)

  // middle change — what OLD compaction did: insert a summary-sized block right
  // after the system prompt, shifting the whole conversation. the prefix
  // diverges at index 1, so everything after re-prefills (duration back near cold)
  const summaryBlock: OllamaMessage = {
    role: 'user',
    content: `[Conversation handoff]\n${'summary of earlier work and decisions. '.repeat(40)}`,
  }
  const mutated: OllamaMessage[] = [
    base[0]!,
    summaryBlock,
    ...base.slice(1),
    { role: 'assistant', content: 'Acknowledged.' },
    {
      role: 'user',
      content: 'One more follow-up question to extend the tail.',
    },
  ]
  const busted = await measurePrefill(client, model, mutated)

  // reuse is measured on prefill TIME, not token count (count ignores the cache)
  const reuse = cold.ms > 0 ? 1 - warm.ms / cold.ms : 0

  console.log(
    `cold prefill (full):         ${cold.ms.toFixed(0)}ms  (${cold.tokens} prompt tokens)`
  )
  console.log(
    `warm prefill (append-only):  ${warm.ms.toFixed(0)}ms  (${warm.tokens} prompt tokens)`
  )
  console.log(
    `busted prefill (mid-change): ${busted.ms.toFixed(0)}ms  (${busted.tokens} prompt tokens)`
  )
  console.log(
    `\nprefix reuse on append: ${(reuse * 100).toFixed(0)}% faster prefill`
  )

  if (reuse >= 0.5)
  {
    console.log(
      '\nVERDICT: this model reuses its prefix KV cache. Cache-friendly\n' +
        'compaction (stable prefix + append-only summaries) reduces re-prefill\n' +
        'latency on long sessions. (Note: prompt_eval_count stays constant — the\n' +
        'win is in prompt_eval_duration, shown above.)'
    )
  }
  else
  {
    console.log(
      '\nVERDICT: this model does NOT meaningfully reuse its prefix cache\n' +
        '(common for SWA / Gemma / MLX-engine models). Stable-prefix\n' +
        'compaction is a no-op here until llama.cpp adds partial reuse —\n' +
        'try a non-SWA model (e.g. mistral / qwen) to see the win.'
    )
  }
}

void main()
