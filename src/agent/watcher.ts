// src/agent/watcher.ts
// session-owned native file events with bounded hints and joined retirement

import { watch, type FSWatcher } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { createIgnoredEntrySet } from '../shared/ignored-entries.js'
import { isPathInsideProject } from '../shared/project-tree.js'

const DEBOUNCE_MS = 75
const FALLBACK_INTERVAL_MS = 30_000
const MAX_CHANGED_PATHS = 256
const MAX_CHANGED_PATH_CHARS = 4_096

interface ProjectWatcherCallbacks
{
  onFilesChanged: (paths: readonly string[] | null) => void
  onProjectFilesChanged: () => void
}

// native events are hints only; periodic invalidation refreshes catalog
// snapshots after missed events without walking or reading the project here
export class ProjectWatcher
{
  private watcher?: FSWatcher
  private readonly ignored = createIgnoredEntrySet()
  private readonly changed = new Set<string>()
  private allChanged = false
  private catalogChanged = false
  private retired = false
  private flushTimer?: ReturnType<typeof setTimeout>
  private readonly fallbackTimer: ReturnType<typeof setInterval>
  private closePromise: Promise<void> = Promise.resolve()

  constructor(
    private readonly cwd: string,
    private readonly callbacks: ProjectWatcherCallbacks
  )
  {
    try
    {
      const watcher = watch(
        cwd,
        { recursive: true, persistent: false },
        (event, filename) =>
        {
          this.enqueue(filename, event === 'rename')
        }
      )
      this.watcher = watcher
      this.closePromise = new Promise((resolveClosed) =>
        watcher.once('close', resolveClosed)
      )
      watcher.on('error', () =>
      {
        this.enqueue(null, true)
        watcher.close()
      })
    }
    catch
    {
      // request-time metadata checks and periodic catalog invalidation remain
      this.enqueue(null, true)
    }
    this.fallbackTimer = setInterval(
      () => this.enqueue(null, true),
      FALLBACK_INTERVAL_MS
    )
    this.fallbackTimer.unref()
  }

  // retirement closes event admission synchronously before joining native close
  dispose(): Promise<void>
  {
    if (!this.retired)
    {
      this.retired = true
      clearTimeout(this.flushTimer)
      clearInterval(this.fallbackTimer)
      this.changed.clear()
      this.watcher?.close()
    }
    return this.closePromise
  }

  private enqueue(filename: string | null, rename: boolean): void
  {
    if (this.retired) return
    if (filename === null)
    {
      this.allChanged = true
    }
    else
    {
      const absolute = resolve(this.cwd, filename)
      if (!isPathInsideProject(this.cwd, absolute)) return
      const path = relative(this.cwd, absolute).split(sep).join('/')
      const ignoreRule =
        path === '.gitignore' ||
        path.endsWith('/.gitignore') ||
        path === '.git/info/exclude'
      if (!ignoreRule && path.split('/').some((part) => this.ignored.has(part)))
        return
      this.catalogChanged ||= ignoreRule
      if (
        path.length > MAX_CHANGED_PATH_CHARS ||
        this.changed.size >= MAX_CHANGED_PATHS
      )
      {
        this.allChanged = true
        this.changed.clear()
      }
      else if (!this.allChanged)
      {
        this.changed.add(absolute)
      }
    }
    this.catalogChanged ||= rename
    this.flushTimer ??= setTimeout(() => this.flush(), DEBOUNCE_MS)
    this.flushTimer.unref()
  }

  private flush(): void
  {
    this.flushTimer = undefined
    if (this.retired) return
    const paths = this.allChanged ? null : [...this.changed]
    const catalogChanged = this.catalogChanged
    this.changed.clear()
    this.allChanged = false
    this.catalogChanged = false
    try
    {
      this.callbacks.onFilesChanged(paths)
    }
    catch
    {
      // watcher notifications must not interrupt an interactive turn
    }
    if (catalogChanged)
    {
      try
      {
        this.callbacks.onProjectFilesChanged()
      }
      catch
      {
        // catalog refresh remains available explicitly after a callback failure
      }
    }
  }
}
