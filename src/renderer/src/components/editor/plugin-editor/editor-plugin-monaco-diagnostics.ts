import type { editor } from 'monaco-editor'
import type { RendererEditorDiagnosticsEvent } from '../../../../../shared/plugins/plugin-editor-renderer-contract'
import type { EditorDiagnostic } from '../../../../../shared/plugins/plugin-editor-protocol'
import { toMonacoRange } from './editor-plugin-position'

type MonacoDiagnosticsApi = {
  MarkerSeverity: { Error: number; Warning: number; Info: number; Hint: number }
  editor: {
    setModelMarkers(model: editor.ITextModel, owner: string, markers: editor.IMarkerData[]): void
  }
}

export function editorPluginMarkerOwner(pluginKey: string, providerId: string): string {
  return `plugin:${pluginKey}:${providerId}`
}

function markerSeverity(monaco: MonacoDiagnosticsApi, diagnostic: EditorDiagnostic): number {
  switch (diagnostic.severity) {
    case 'error':
      return monaco.MarkerSeverity.Error
    case 'warning':
      return monaco.MarkerSeverity.Warning
    case 'information':
      return monaco.MarkerSeverity.Info
    case 'hint':
      return monaco.MarkerSeverity.Hint
  }
}

export function applyEditorPluginDiagnostics(
  monaco: MonacoDiagnosticsApi,
  model: editor.ITextModel,
  event: RendererEditorDiagnosticsEvent,
  documentId: string,
  version: number
): boolean {
  if (event.publication.documentId !== documentId || event.publication.version !== version) {
    return false
  }
  monaco.editor.setModelMarkers(
    model,
    editorPluginMarkerOwner(event.pluginKey, event.providerId),
    event.publication.diagnostics.map((diagnostic) => ({
      ...toMonacoRange(diagnostic.range),
      severity: markerSeverity(monaco, diagnostic),
      message: diagnostic.message,
      code: diagnostic.code,
      source: diagnostic.source
    }))
  )
  return true
}
