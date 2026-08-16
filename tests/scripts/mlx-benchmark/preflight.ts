// tests/scripts/mlx-benchmark/preflight.ts
// deterministic local-artifact gate before model launch or download

import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type {
  BaselineSmokeEvidence,
  OllamaTopologyConfig,
  HardGateObservation,
  ModelPair,
  TopologyIdentity,
} from './types.js'

function numeric(value: unknown): number
{
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function failedBaselineSmoke(
  topology: OllamaTopologyConfig,
  pair: ModelPair,
  detail: string,
  artifactRevision: string
): BaselineSmokeEvidence
{
  return {
    topologyId: topology.id,
    modelPairId: pair.id,
    passed: false,
    detail,
    temperature: 0,
    think: false,
    contextWindow: 4_096,
    promptTokens: 0,
    completionTokens: 0,
    loadMs: 0,
    totalMs: 0,
    finishReason: '',
    artifactRevision,
  }
}

export async function runBaselineSmoke(
  topology: OllamaTopologyConfig,
  pair: ModelPair,
  requestTimeoutMs: number
): Promise<BaselineSmokeEvidence>
{
  let manifestRevision = 'unresolved'
  try
  {
    const manifestBytes = await readFile(pair.ollama.localPath)
    manifestRevision = createHash('sha256').update(manifestBytes).digest('hex')
    if (manifestRevision !== pair.ollama.revision)
    {
      throw new Error(
        `Ollama manifest is ${manifestRevision}, expected ${pair.ollama.revision}`
      )
    }
    const tagsResponse = await fetch(`${topology.host}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!tagsResponse.ok)
    {
      throw new Error(`Ollama tags returned HTTP ${tagsResponse.status}`)
    }
    const tags = (await tagsResponse.json()) as Record<string, unknown>
    const models = Array.isArray(tags.models) ? tags.models : []
    const listed = models.find((value) =>
    {
      if (typeof value !== 'object' || value === null) return false
      const item = value as Record<string, unknown>
      return item.name === pair.ollama.model || item.model === pair.ollama.model
    }) as Record<string, unknown> | undefined
    const listedRevision =
      typeof listed?.digest === 'string'
        ? listed.digest.replace(/^sha256:/, '')
        : ''
    if (listedRevision !== pair.ollama.revision)
    {
      throw new Error(
        `Ollama tag is ${listedRevision || 'unresolved'}, expected ${pair.ollama.revision}`
      )
    }
    const response = await fetch(`${topology.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: pair.ollama.model,
        messages: [
          { role: 'user', content: 'Reply with exactly OK and nothing else.' },
        ],
        stream: false,
        think: false,
        keep_alive: '10m',
        options: {
          temperature: 0,
          num_ctx: 4_096,
          num_predict: 8,
        },
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (!response.ok)
    {
      return failedBaselineSmoke(
        topology,
        pair,
        `Ollama smoke returned HTTP ${response.status}`,
        manifestRevision
      )
    }
    const payload = (await response.json()) as Record<string, unknown>
    const message = payload.message as Record<string, unknown> | undefined
    const content = typeof message?.content === 'string' ? message.content : ''
    const finishReason =
      typeof payload.done_reason === 'string' ? payload.done_reason : ''
    const passed = content.trim() === 'OK' && finishReason === 'stop'
    return {
      topologyId: topology.id,
      modelPairId: pair.id,
      passed,
      detail: passed
        ? 'Ollama returned exact OK'
        : `Ollama returned ${JSON.stringify(content)}`,
      temperature: 0,
      think: false,
      contextWindow: 4_096,
      promptTokens: numeric(payload.prompt_eval_count),
      completionTokens: numeric(payload.eval_count),
      loadMs: numeric(payload.load_duration) / 1e6,
      totalMs: numeric(payload.total_duration) / 1e6,
      finishReason,
      artifactRevision: manifestRevision,
    }
  }
  catch (error)
  {
    return failedBaselineSmoke(
      topology,
      pair,
      `Ollama baseline smoke failed closed: ${error instanceof Error ? error.message : String(error)}`,
      manifestRevision
    )
  }
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function isRegularFile(path: string): Promise<boolean>
{
  try
  {
    return (await stat(path)).isFile()
  }
  catch
  {
    return false
  }
}

async function inspectDirectArtifact(pair: ModelPair): Promise<string>
{
  const configured = resolve(pair.mlx.localPath)
  const resolved = await realpath(configured)
  const info = await stat(resolved)
  if (!info.isDirectory())
  {
    throw new Error(`pinned direct artifact is not a directory: ${resolved}`)
  }
  if (basename(resolved) !== pair.mlx.revision)
  {
    throw new Error(
      `direct artifact resolved to ${basename(resolved)}, expected revision ${pair.mlx.revision}`
    )
  }
  const files = new Set(await readdir(resolved))
  const missing: string[] = []
  for (const required of [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'model.safetensors.index.json',
  ])
  {
    if (
      !files.has(required) ||
      !(await isRegularFile(join(resolved, required)))
    )
    {
      missing.push(required)
    }
  }

  const indexPath = join(resolved, 'model.safetensors.index.json')
  let shardNames: string[] = []
  if (await isRegularFile(indexPath))
  {
    try
    {
      const index = jsonRecord(JSON.parse(await readFile(indexPath, 'utf8')))
      const weightMap = jsonRecord(index?.weight_map)
      if (!weightMap || Object.keys(weightMap).length === 0)
      {
        missing.push('nonempty safetensors weight_map')
      }
      else
      {
        const referenced = Object.values(weightMap)
        const unsafe = referenced.filter(
          (value) =>
            typeof value !== 'string' ||
            basename(value) !== value ||
            !value.endsWith('.safetensors')
        )
        if (unsafe.length > 0)
        {
          missing.push(`${unsafe.length} safe safetensors shard references`)
        }
        else
        {
          shardNames = [...new Set(referenced as string[])].sort()
          const inaccessible = (
            await Promise.all(
              shardNames.map(async (name) =>
                (await isRegularFile(join(resolved, name))) ? undefined : name
              )
            )
          ).filter((name): name is string => name !== undefined)
          if (inaccessible.length > 0)
          {
            missing.push(
              `${inaccessible.length} of ${shardNames.length} accessible safetensors weight shards`
            )
          }
        }
      }
    }
    catch (error)
    {
      missing.push(
        `valid safetensors index (${error instanceof Error ? error.message : String(error)})`
      )
    }
  }

  for (const name of ['config.json', 'tokenizer.json'])
  {
    const path = join(resolved, name)
    if (!(await isRegularFile(path))) continue
    try
    {
      if (!jsonRecord(JSON.parse(await readFile(path, 'utf8'))))
      {
        missing.push(`object-shaped ${name}`)
      }
    }
    catch
    {
      missing.push(`valid ${name}`)
    }
  }

  const tokenizerConfigPath = join(resolved, 'tokenizer_config.json')
  if (await isRegularFile(tokenizerConfigPath))
  {
    try
    {
      const tokenizerConfig = jsonRecord(
        JSON.parse(await readFile(tokenizerConfigPath, 'utf8'))
      )
      const inlineTemplate = tokenizerConfig?.chat_template
      const templatePath = join(resolved, 'chat_template.jinja')
      const template =
        typeof inlineTemplate === 'string' || Array.isArray(inlineTemplate)
          ? typeof inlineTemplate === 'string'
            ? inlineTemplate
            : JSON.stringify(inlineTemplate)
          : (await isRegularFile(templatePath))
            ? await readFile(templatePath, 'utf8')
            : undefined
      if (!template)
      {
        missing.push('accessible tokenizer chat template')
      }
      else
      {
        const digest = createHash('sha256').update(template).digest('hex')
        if (digest !== pair.mlx.chatTemplateSha256)
        {
          missing.push(
            `chat template digest ${digest} (expected ${pair.mlx.chatTemplateSha256})`
          )
        }
      }
    }
    catch (error)
    {
      missing.push(
        `valid tokenizer_config.json (${error instanceof Error ? error.message : String(error)})`
      )
    }
  }

  if (
    shardNames.length === 0 &&
    !missing.includes('nonempty safetensors weight_map')
  )
  {
    missing.push('referenced safetensors weight shards')
  }
  if (missing.length > 0)
  {
    throw new Error(
      `pinned direct artifact omitted or could not verify ${missing.join('; ')}`
    )
  }
  return resolved
}

export async function runArtifactPreflight(
  topology: TopologyIdentity,
  pair: ModelPair,
  sequence: number
): Promise<HardGateObservation>
{
  try
  {
    const path = await inspectDirectArtifact(pair)
    return {
      topologyId: topology.id,
      modelPairId: pair.id,
      category: 'artifact-availability',
      caseId: 'pinned-direct-artifact-installed',
      repetition: 1,
      passed: true,
      detail: `pinned direct artifact is installed at ${path}`,
      sequence,
    }
  }
  catch (error)
  {
    return {
      topologyId: topology.id,
      modelPairId: pair.id,
      category: 'artifact-availability',
      caseId: 'pinned-direct-artifact-installed',
      repetition: 1,
      passed: false,
      detail:
        `pinned direct artifact ${pair.mlx.model}@${pair.mlx.revision} is not ` +
        `installed and benchmark downloads are forbidden: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      sequence,
    }
  }
}
