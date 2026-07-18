// src/tui/session/project-file-catalog.ts
// own one interactive session's refreshable project-file snapshots

import { collectProjectFileSuggestions } from '../prompt/file-suggestions.js'

export type ProjectFileCollector = (
  cwd: string,
  signal: AbortSignal
) => Promise<string[]>

interface CatalogEntry
{
  generation: number
  controller: AbortController
  snapshot?: string[]
  pending?: Promise<string[]>
  rejectStale?: () => void
}

export class StaleProjectFileCatalogRequestError extends Error
{
  constructor(cwd: string)
  {
    super(`Project file request for ${cwd} is stale`)
    this.name = 'StaleProjectFileCatalogRequestError'
  }
}

export class ProjectFileCatalog
{
  private readonly entries = new Map<string, CatalogEntry>()
  private readonly outstandingCollections = new Set<Promise<void>>()
  private nextGeneration = 1
  private disposed = false
  private disposePromise: Promise<void> | null = null

  constructor(
    private readonly collect: ProjectFileCollector = collectProjectFileSuggestions
  )
  {}

  list(cwd: string): Promise<string[]>
  {
    if (this.disposed) return Promise.reject(this.staleError(cwd))
    const entry = this.entries.get(cwd)
    if (entry?.snapshot) return Promise.resolve(entry.snapshot)
    if (entry?.pending) return entry.pending
    return this.startCollection(cwd, entry?.snapshot)
  }

  refresh(cwd: string): Promise<string[]>
  {
    if (this.disposed) return Promise.reject(this.staleError(cwd))
    const current = this.entries.get(cwd)
    if (current) this.retireEntry(cwd, current)
    return this.startCollection(cwd, current?.snapshot)
  }

  invalidate(cwd?: string): void
  {
    if (cwd !== undefined)
    {
      const entry = this.entries.get(cwd)
      if (entry) this.retireEntry(cwd, entry)
      this.entries.delete(cwd)
      return
    }

    for (const [entryCwd, entry] of this.entries)
    {
      this.retireEntry(entryCwd, entry)
    }
    this.entries.clear()
  }

  dispose(): Promise<void>
  {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.invalidate()
    const outstanding = [...this.outstandingCollections]
    this.disposePromise = Promise.all(outstanding).then(() => undefined)
    return this.disposePromise
  }

  private startCollection(
    cwd: string,
    previousSnapshot?: string[]
  ): Promise<string[]>
  {
    const controller = new AbortController()
    const entry: CatalogEntry = {
      generation: this.nextGeneration++,
      controller,
      snapshot: previousSnapshot,
    }
    this.entries.set(cwd, entry)

    let settled = false
    const pending = new Promise<string[]>((resolve, reject) =>
    {
      entry.rejectStale = () =>
      {
        if (settled) return
        settled = true
        reject(new StaleProjectFileCatalogRequestError(cwd))
      }

      let collected: Promise<string[]>
      try
      {
        collected = this.collect(cwd, controller.signal)
      }
      catch (error)
      {
        collected = Promise.reject(error)
      }
      this.trackCollection(collected)

      void collected.then(
        (paths) =>
        {
          if (settled) return
          if (this.entries.get(cwd)?.generation !== entry.generation)
          {
            entry.rejectStale?.()
            return
          }

          settled = true
          const snapshot = Object.freeze([...paths]) as string[]
          entry.snapshot = snapshot
          entry.pending = undefined
          entry.rejectStale = undefined
          resolve(snapshot)
        },
        (error: unknown) =>
        {
          if (settled) return
          if (this.entries.get(cwd)?.generation !== entry.generation)
          {
            entry.rejectStale?.()
            return
          }

          settled = true
          entry.pending = undefined
          entry.rejectStale = undefined
          reject(error)
        }
      )
    })
    entry.pending = pending
    return pending
  }

  private retireEntry(cwd: string, entry: CatalogEntry): void
  {
    const error = this.staleError(cwd)
    if (entry.pending) entry.controller.abort(error)
    entry.rejectStale?.()
  }

  private trackCollection(collection: Promise<string[]>): void
  {
    const joined = collection.then(
      () => undefined,
      () => undefined
    )
    this.outstandingCollections.add(joined)
    void joined.then(() => this.outstandingCollections.delete(joined))
  }

  private staleError(cwd: string): StaleProjectFileCatalogRequestError
  {
    return new StaleProjectFileCatalogRequestError(cwd)
  }
}
