import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type {
  EditorProviderBinding,
  RendererEditorDiagnosticsEvent
} from '../../shared/plugins/plugin-editor-renderer-contract'
import type {
  PluginEditorProviderExtension,
  PluginExtensionRegistry
} from '../../shared/plugins/plugin-extension-registry'
import type { DiscoveredPlugin, ValidDiscoveredPlugin } from './plugin-discovery'

export type { EditorProviderBinding, RendererEditorDiagnosticsEvent }

export type BoundProvider = EditorProviderBinding & {
  key: string
  provider: PluginEditorProviderExtension
  unsubscribeDiagnostics: (() => void) | null
}

export type DocumentState = {
  ownerKey: string
  documentId: string
  worktreeId: string
  version: number
  bindings: BoundProvider[]
}

export type PendingCompletion = {
  documentKey: string
  binding: BoundProvider
}

export type PluginEditorRouterOptions = {
  getPlugins: () => readonly DiscoveredPlugin[]
  getGrantedCapabilities: (pluginKey: string) => readonly PluginCapabilityKind[] | null
  ensurePlugin: (plugin: ValidDiscoveredPlugin) => Promise<unknown>
  registry: PluginExtensionRegistry
  onDiagnostics: (event: RendererEditorDiagnosticsEvent) => void
  leases?: {
    acquire(pluginKey: string, worktreeId: string, documentKey: string): void
    release(pluginKey: string, worktreeId: string, documentKey: string): void
    revokePlugin(pluginKey: string): void
    has(pluginKey: string, worktreeId: string): boolean
  }
}
