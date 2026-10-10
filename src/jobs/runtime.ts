// src/jobs/runtime.ts
// resolve private task-control paths and the current Coral process entrypoint

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jobsDirectory } from './store.js'

// aliases and client-specific temporary directories must resolve to one supervisor
function canonicalJobsDirectory(): string
{
  let ancestor = resolve(jobsDirectory())
  const missing: string[] = []
  while (!existsSync(ancestor))
  {
    missing.unshift(basename(ancestor))
    ancestor = dirname(ancestor)
  }
  return join(realpathSync(ancestor), ...missing)
}

export function jobProcessEnvironment(
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv
{
  return { ...base, CORAL_HOME: dirname(canonicalJobsDirectory()) }
}

export function jobRuntimePaths(): {
  directory: string
  socket: string
  lock: string
  owner: string
  active: string
}
{
  const hash = createHash('sha256')
    .update(canonicalJobsDirectory())
    .digest('hex')
    .slice(0, 20)
  const directory = join(
    '/tmp',
    `coral-jobs-${process.getuid?.() ?? 'user'}-${hash}`
  )
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
  {
    throw new Error(
      'Task control directory is not privately owned by this user.'
    )
  }
  chmodSync(directory, 0o700)
  const lock = join(directory, 'supervisor.lock')
  return {
    directory,
    socket: join(directory, 'control.sock'),
    lock,
    owner: join(lock, 'owner.json'),
    active: join(directory, 'active.json'),
  }
}

export function coralJobProcessArgs(...args: string[]): string[]
{
  const source = import.meta.url.endsWith('.ts')
  const entry = fileURLToPath(
    new URL(source ? '../cli/main.tsx' : '../cli/main.js', import.meta.url)
  )
  return source
    ? ['--import', import.meta.resolve('tsx'), entry, 'jobs', ...args]
    : [entry, 'jobs', ...args]
}
