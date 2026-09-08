import type { PluginEditorProviderFeature } from './plugin-editor-contributions'
import type { EditorDiagnosticsPublication } from './plugin-editor-protocol'

export type EditorProviderBinding = {
  pluginKey: string
  providerId: string
  features: readonly PluginEditorProviderFeature[]
}

export type RendererEditorDiagnosticsEvent = EditorProviderBinding & {
  ownerKey: string
  publication: EditorDiagnosticsPublication
}
