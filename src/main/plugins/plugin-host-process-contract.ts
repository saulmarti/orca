import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import type {
  EditorCompletionRequest,
  EditorCompletionResponse,
  EditorDiagnosticsPublication,
  EditorDocumentChange,
  EditorDocumentClose,
  EditorDocumentOpen
} from '../../shared/plugins/plugin-editor-protocol'

export type PluginWorkerLogSink = (level: 'info' | 'warn' | 'error', line: string) => void

export type PluginWorkerHostCallExecutor = (
  method: string,
  params: unknown
) => Promise<PluginPanelActionOutcome>

export type PluginWorkerHandle = {
  commands: readonly string[]
  editorProviders: readonly string[]
  invokeCommand(commandId: string, args?: unknown): Promise<unknown>
  deliverEvent(event: PluginEventName, payload: unknown): void
  openEditorDocument(providerId: string, document: EditorDocumentOpen): void
  changeEditorDocument(providerId: string, change: EditorDocumentChange): void
  closeEditorDocument(providerId: string, document: EditorDocumentClose): void
  requestEditorCompletion(
    providerId: string,
    request: EditorCompletionRequest
  ): Promise<EditorCompletionResponse>
  cancelEditorRequest(requestId: string): void
  onEditorDiagnostics(
    callback: (providerId: string, publication: EditorDiagnosticsPublication) => void
  ): () => void
  lastActivityAt(): number
  inFlightCount(): number
  dispose(): Promise<void>
  kill(): void
  onExit(callback: (code: number | null) => void): void
}

export type StartPluginWorkerOptions = {
  pluginId: string
  rootDir: string
  mainEntry: string
  entryPath: string
  grantedCapabilities: readonly PluginCapabilityKind[]
  executeHostCall: PluginWorkerHostCallExecutor
  log: PluginWorkerLogSink
  readyTimeoutMs?: number
  invokeTimeoutMs?: number
  eventTimeoutMs?: number
  signal?: AbortSignal
}

export function resolvePluginHostEntryPath(appPath: string, isPackaged: boolean): string {
  const basePath = isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const directEntryPath = join(basePath, 'plugin-host-entry.js')
  if (existsSync(directEntryPath)) {
    return directEntryPath
  }
  return join(basePath, 'out', 'main', 'plugin-host-entry.js')
}
