import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import { executePluginHostCallRequest } from './plugin-host-call-adapter'
import { assertPluginWorkerCommand } from './plugin-command-invocation'
import { deliverPluginEvent } from './plugin-event-delivery'
import type { DiscoveredPlugin, ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginEventBus } from './plugin-event-bus'
import type { PluginAuditLog } from './plugin-audit-log'
import type { PluginWorkerController } from './plugin-worker-controller'

export class PluginServiceRuntimeOperations {
  constructor(
    private readonly options: {
      pluginsDataDir: string
      eventBus: PluginEventBus
      audit: PluginAuditLog
      workerController: PluginWorkerController
      getPlugins: () => readonly DiscoveredPlugin[]
      findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
      isRuntimeApproved: (plugin: ValidDiscoveredPlugin) => boolean
      getGrantedCapabilities: (pluginKey: string) => PluginCapabilityKind[] | null
      getRuntimeDelegate: () => PluginRuntimeDelegate | null
      isPluginSystemEnabled: () => boolean
      isDisposed: () => boolean
      logWarning: (pluginKey: string, line: string) => void
    }
  ) {}

  executeHostCall(
    pluginKey: string,
    method: string,
    params: unknown,
    viaPanel: boolean
  ): Promise<PluginPanelActionOutcome> {
    return executePluginHostCallRequest({
      pluginKey,
      request: { method, params },
      viaPanel,
      resolvePolicy: (boundPluginKey) => ({
        grantedCapabilities: this.options.getGrantedCapabilities(boundPluginKey),
        services: this.runtimeServices(),
        audit: this.options.audit
      })
    })
  }

  async invokeCommand(pluginKey: string, commandId: string, args?: unknown): Promise<unknown> {
    const plugin = this.options.findValidPlugin(pluginKey)
    if (!plugin || !this.options.isRuntimeApproved(plugin)) {
      throw new Error(`plugin ${pluginKey} is not enabled`)
    }
    assertPluginWorkerCommand(plugin, commandId)
    const handle = await this.options.workerController.ensure(plugin)
    if (!handle.commands.includes(commandId)) {
      throw new Error(`plugin ${pluginKey} registered no handler for ${commandId}`)
    }
    return handle.invokeCommand(commandId, args)
  }

  emitEvent(event: PluginEventName, payload: unknown): void {
    if (!this.options.isPluginSystemEnabled() || this.options.isDisposed()) {
      return
    }
    deliverPluginEvent({
      event,
      payload,
      plugins: this.options.getPlugins(),
      eventBus: this.options.eventBus,
      workerController: this.options.workerController,
      isRuntimeApproved: this.options.isRuntimeApproved,
      logWarning: this.options.logWarning
    })
  }

  private runtimeServices() {
    const delegate = this.options.getRuntimeDelegate()
    return delegate
      ? bindPluginHostServices({
          delegate,
          pluginsDataDir: this.options.pluginsDataDir,
          subscribeEvents: (pluginKey, events) => this.options.eventBus.subscribe(pluginKey, events)
        })
      : null
  }
}
