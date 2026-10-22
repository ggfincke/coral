// src/config/memory-budget.ts
// detect the memory pool that bounds the model's context window

import { totalmem } from 'node:os'
import { execFileCommand } from '../utils/process.js'

const MiB = 1024 ** 2

// keep a missing or wedged driver from stalling context resolution
const NVIDIA_SMI_TIMEOUT_MS = 2_000

export type MemoryKind = 'unified' | 'discrete'

export interface MemoryBudget
{
  kind: MemoryKind
  totalBytes: number
}

let memoryBudget: Promise<MemoryBudget> | undefined

// probe once per process since GPU memory does not change mid-session
export function resolveMemoryBudget(): Promise<MemoryBudget>
{
  memoryBudget ??= detectMemoryBudget()
  return memoryBudget
}

// prefer total NVIDIA VRAM, falling back to system RAM for unified memory or
// GPUs nvidia-smi cannot see
async function detectMemoryBudget(): Promise<MemoryBudget>
{
  const unified: MemoryBudget = { kind: 'unified', totalBytes: totalmem() }
  if (process.platform === 'darwin') return unified

  const result = await execFileCommand(
    'nvidia-smi',
    ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
    { timeout: NVIDIA_SMI_TIMEOUT_MS }
  )
  if (!result.ok) return unified

  // sum every GPU since Ollama splits layers across them
  let totalMiB = 0
  for (const line of result.stdout.split('\n'))
  {
    const value = Number.parseInt(line.trim(), 10)
    if (Number.isFinite(value) && value > 0) totalMiB += value
  }

  return totalMiB > 0
    ? { kind: 'discrete', totalBytes: totalMiB * MiB }
    : unified
}
