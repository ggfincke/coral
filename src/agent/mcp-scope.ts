// src/agent/mcp-scope.ts
// agent-local MCP manager bootstrap, admission, and retirement

import type { ToolPermissions } from '../config/permissions.js'
import { resolveMcpConfig, type McpConfigResolution } from '../config/mcp.js'
import {
  configuredMcpStatus,
  type McpLaunchApprovalRequest,
  type McpStatus,
} from '../mcp/types.js'
import type { Tool } from '../tools/tool.js'
import { raceAbort } from '../utils/abort.js'
import type { AgentMcpManager, AgentMcpManagerFactory } from './contracts.js'

export interface McpToolAdmission
{
  maxDynamicToolTokens: number
  signal?: AbortSignal
  onLaunchApproval?: (request: McpLaunchApprovalRequest) => Promise<boolean>
  // commit the proposed tool snapshot and its matching prompt without awaiting
  admit: (tools: readonly Tool[]) => void
}

export interface McpToolScopeOptions
{
  enabled: boolean
  config?: McpConfigResolution
  permissions: ToolPermissions
  baseTools: readonly Tool[]
  managerFactory?: AgentMcpManagerFactory
  lifecycleSignal: AbortSignal
}

// * Own one Agent's lazy MCP manager identity and cleanup
export class McpToolScope
{
  private enabled: boolean
  private config?: McpConfigResolution
  private readonly permissions: ToolPermissions
  private readonly baseTools: readonly Tool[]
  private readonly managerFactory?: AgentMcpManagerFactory
  private readonly parentLifecycleSignal: AbortSignal
  private readonly lifecycleAbort = new AbortController()
  private currentManager?: AgentMcpManager
  private installedManager?: AgentMcpManager
  private bootstrapEpoch = 0
  private bootstrapPromise?: Promise<void>
  private readonly retirements = new Set<Promise<void>>()
  private readonly managerRetirements = new WeakMap<
    AgentMcpManager,
    Promise<void>
  >()
  private disposePromise?: Promise<void>

  constructor(options: McpToolScopeOptions)
  {
    this.enabled = options.enabled
    this.config = options.config
    this.permissions = options.permissions
    this.baseTools = options.baseTools
    this.managerFactory = options.managerFactory
    this.parentLifecycleSignal = options.lifecycleSignal
  }

  isEnabled(): boolean
  {
    return (
      this.enabled &&
      !this.parentLifecycleSignal.aborted &&
      !this.lifecycleAbort.signal.aborted
    )
  }

  getStatus(): McpStatus
  {
    if (this.currentManager) return this.currentManager.getStatus()
    this.config ??= resolveMcpConfig()
    return configuredMcpStatus(this.config)
  }

  setEnabled(enabled: boolean, signal?: AbortSignal): void
  {
    signal?.throwIfAborted()
    this.parentLifecycleSignal.throwIfAborted()
    this.lifecycleAbort.signal.throwIfAborted()
    this.enabled = enabled
  }

  bootstrap(options: McpToolAdmission): Promise<void>
  {
    const bootstrapSignal = AbortSignal.any(
      [
        options.signal,
        this.parentLifecycleSignal,
        this.lifecycleAbort.signal,
      ].filter((signal): signal is AbortSignal => signal !== undefined)
    )
    if (!this.isEnabled() || bootstrapSignal.aborted)
    {
      return Promise.resolve()
    }
    if (this.bootstrapPromise)
    {
      return raceAbort(this.bootstrapPromise, bootstrapSignal)
    }

    const epoch = this.bootstrapEpoch
    const bootstrap = this.bootstrapInternal(options, bootstrapSignal, epoch)
    this.bootstrapPromise = bootstrap
    const clear = () =>
    {
      if (this.bootstrapPromise === bootstrap)
      {
        this.bootstrapPromise = undefined
      }
    }
    bootstrap.then(clear, clear)
    return bootstrap
  }

  // remove model-visible capability state before awaiting process cleanup
  retireCurrent(afterDetach: () => void): Promise<void>
  {
    const manager = this.currentManager
    const bootstrap = this.bootstrapPromise
    this.bootstrapEpoch++
    this.bootstrapPromise = undefined
    this.currentManager = undefined
    this.installedManager = undefined

    let detachFailed = false
    let detachError: unknown
    try
    {
      afterDetach()
    }
    catch (error)
    {
      detachFailed = true
      detachError = error
    }

    const managerRetirement = this.retireManager(manager)
    const joined = Promise.allSettled([
      managerRetirement,
      ...(bootstrap ? [bootstrap] : []),
    ]).then((results) =>
    {
      if (detachFailed) throw detachError
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected'
      )
      if (failed) throw failed.reason
    })
    return this.trackRetirement(joined)
  }

  dispose(): Promise<void>
  {
    if (!this.disposePromise)
    {
      this.enabled = false
      this.lifecycleAbort.abort()
      this.disposePromise = this.disposeInternal()
    }
    return this.disposePromise
  }

  private async createManager(
    maxDynamicToolTokens: number
  ): Promise<AgentMcpManager>
  {
    if (this.managerFactory) return this.managerFactory()
    this.config ??= resolveMcpConfig()
    const { McpManager } = await import('../mcp/manager.js')
    return new McpManager({
      config: this.config,
      permissions: this.permissions,
      baseTools: this.baseTools,
      maxDynamicToolTokens,
    })
  }

  private async bootstrapInternal(
    options: McpToolAdmission,
    signal: AbortSignal,
    epoch: number
  ): Promise<void>
  {
    const existing = this.currentManager
    const manager =
      existing ?? (await this.createManager(options.maxDynamicToolTokens))

    // close managers created for a retired bootstrap generation
    if (epoch !== this.bootstrapEpoch)
    {
      await this.retireManager(manager)
      return
    }

    // leave an existing installed manager for Agent disposal to retire
    if (!this.isEnabled() || signal.aborted)
    {
      if (!existing) await this.retireManager(manager)
      return
    }

    this.currentManager ??= manager
    if (this.currentManager !== manager)
    {
      if (!existing) await this.retireManager(manager)
      return
    }
    if (this.installedManager === manager) return

    let tools: Tool[]
    try
    {
      tools = await manager.initialize({
        signal,
        onLaunchApproval: options.onLaunchApproval,
      })
    }
    catch (error)
    {
      await this.retireUninstalledManager(manager).catch(() => undefined)
      throw error
    }

    if (epoch !== this.bootstrapEpoch)
    {
      await this.retireManager(manager)
      return
    }
    if (this.currentManager !== manager)
    {
      await this.retireManager(manager)
      return
    }
    if (!this.isEnabled() || signal.aborted)
    {
      await this.retireUninstalledManager(manager)
      return
    }

    // require every configured launch to settle before exposing any tools
    if (
      manager
        .getStatus()
        .servers.some((server) => server.state === 'needs_trust')
    )
    {
      await this.retireUninstalledManager(manager)
      return
    }

    const proposedTools = Object.freeze([...tools])
    options.admit(proposedTools)
    this.installedManager = manager
  }

  private retireUninstalledManager(manager: AgentMcpManager): Promise<void>
  {
    if (this.currentManager !== manager || this.installedManager === manager)
    {
      return Promise.resolve()
    }

    this.currentManager = undefined
    this.installedManager = undefined
    return this.retireManager(manager)
  }

  private retireManager(manager?: AgentMcpManager): Promise<void>
  {
    if (!manager) return Promise.resolve()
    const tracked = this.managerRetirements.get(manager)
    if (tracked) return tracked

    let retirement: Promise<void>
    try
    {
      retirement = Promise.resolve(manager.dispose())
    }
    catch (error)
    {
      retirement = Promise.reject(error)
    }
    this.managerRetirements.set(manager, retirement)
    return this.trackRetirement(retirement)
  }

  private trackRetirement(retirement: Promise<void>): Promise<void>
  {
    this.retirements.add(retirement)
    const untrack = () => this.retirements.delete(retirement)
    retirement.then(untrack, untrack)
    return retirement
  }

  private async disposeInternal(): Promise<void>
  {
    await this.bootstrapPromise?.catch(() => undefined)
    await Promise.allSettled([...this.retirements])
    await this.retireManager(this.currentManager)
  }
}
