// src/jobs/client.ts
// connect short-lived task controls to the authenticated background supervisor

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { assertJobsPlatform, processIdentity } from './process.js'
import {
  coralJobProcessArgs,
  jobProcessEnvironment,
  jobRuntimePaths,
} from './runtime.js'
import { readSupervisorOwner } from './supervisor.js'
import type { JobRequest, JobResponse } from './types.js'

export function sendJobRequest(request: JobRequest): Promise<JobResponse>
{
  assertJobsPlatform()
  const owner = readSupervisorOwner()
  if (!owner)
    return Promise.reject(new Error('Task supervisor is not running.'))
  return new Promise((resolve, reject) =>
  {
    const socket = createConnection(jobRuntimePaths().socket)
    let text = ''
    let settled = false
    socket.setTimeout(10_000, () =>
      socket.destroy(new Error('Task supervisor did not respond.'))
    )
    socket.once('connect', () =>
    {
      socket.write(`${JSON.stringify({ token: owner.token, request })}\n`)
    })
    socket.on('data', (chunk) =>
    {
      text += chunk.toString('utf8')
      if (text.length > 32 * 1024 * 1024)
      {
        socket.destroy(new Error('Task response exceeds the control limit.'))
        return
      }
      if (!text.includes('\n') || settled) return
      try
      {
        const response = JSON.parse(
          text.slice(0, text.indexOf('\n'))
        ) as JobResponse
        if (typeof response.ok !== 'boolean')
          throw new Error('Invalid task-control response.')
        settled = true
        resolve(response)
        socket.end()
      }
      catch (error)
      {
        settled = true
        reject(error)
        socket.destroy()
      }
    })
    socket.once('error', (error) =>
    {
      if (!settled) reject(error)
    })
    socket.once('close', () =>
    {
      if (!settled)
        reject(new Error('Task supervisor disconnected before responding.'))
    })
  })
}

export async function ensureJobSupervisor(): Promise<void>
{
  assertJobsPlatform()
  const until = Date.now() + 30_000
  let lastError: unknown = new Error('Task supervisor is not running.')
  const ping = async () =>
    sendJobRequest({ action: 'ping' }).catch((error: unknown) =>
    {
      lastError = error
      return undefined
    })
  const initial = await ping()
  if (initial)
  {
    if (!initial.ok) throw new Error(initial.error ?? 'Task queue is blocked.')
    return
  }
  const owner = readSupervisorOwner()
  let launchLog: string | undefined
  let launchError: Error | undefined
  let launchFinished = false
  // recovery may need several joined termination rounds; a live owner is never displaced
  if (!owner || (await processIdentity(owner.pid)) !== owner.identity)
  {
    launchLog = join(jobRuntimePaths().directory, `launch-${randomUUID()}.log`)
    const descriptor = openSync(launchLog, 'wx', 0o600)
    try
    {
      const child = spawn(process.execPath, coralJobProcessArgs('_supervise'), {
        detached: true,
        stdio: ['ignore', descriptor, descriptor],
        env: jobProcessEnvironment(),
      })
      child.once('error', (error) =>
      {
        launchError = error
      })
      child.once('exit', () =>
      {
        launchFinished = true
      })
      child.unref()
    }
    finally
    {
      closeSync(descriptor)
    }
  }
  do
  {
    if (launchError) throw launchError
    const response = await ping()
    if (response)
    {
      if (!response.ok)
        throw new Error(response.error ?? 'Task queue is blocked.')
      return
    }
    if (launchFinished && launchLog)
    {
      const diagnostics = readFileSync(launchLog, 'utf8').slice(-8192).trim()
      if (diagnostics)
        throw new Error(`Task supervisor could not start: ${diagnostics}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < until)
  throw lastError
}

export async function controlJob(
  request: Exclude<JobRequest, { action: 'ping' }>
): Promise<JobResponse>
{
  await ensureJobSupervisor()
  const response = await sendJobRequest(request)
  if (!response.ok) throw new Error(response.error ?? 'Task request failed.')
  return response
}
