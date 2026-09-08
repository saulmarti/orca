import type { RendererEditorDiagnosticsEvent } from '../../shared/plugins/plugin-editor-renderer-contract'

export class PluginEditorDiagnosticsBus {
  private readonly listeners = new Set<(event: RendererEditorDiagnosticsEvent) => void>()

  subscribe(listener: (event: RendererEditorDiagnosticsEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: RendererEditorDiagnosticsEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
