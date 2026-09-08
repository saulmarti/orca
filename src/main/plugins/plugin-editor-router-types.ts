import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginEditorProviderFeature } from '../../shared/plugins/plugin-editor-contributions'
import type { EditorDiagnosticsPublication } from '../../shared/plugins/plugin-editor-protocol'
import type {
  PluginEditorProviderExtension,
  PluginExtensionRegistry
} from '../../shared/plugins/plugin-extension-registry'
import type { DiscoveredPlugin, ValidDiscoveredPlugin } from './plugin-discovery'

export type EditorProviderBinding = {
  pluginKey: string
  providerId: string
  features: readonly PluginEditorProviderFeature[]
}

export type RendererEditorDiagnosticsEvent = EditorProviderBinding & {
  ownerKey: string
  publication: EditorDiagnosticsPublication
}

export type BoundProvider = EditorProviderBinding & {
  key: string
  provider: PluginEditorProviderExtension
  unsubscribeDiagnostics: (() => void) | null
}

export type DocumentState = {
  ownerKey: string
  documentId: string
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
}
