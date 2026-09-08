import type {
  EditorCompletionRequest,
  EditorCompletionResponse,
  EditorDiagnosticsPublication,
  EditorDocumentChange,
  EditorDocumentClose,
  EditorDocumentOpen
} from '../../shared/plugins/plugin-editor-protocol'
import type {
  PluginWorkerChildMessage,
  PluginWorkerParentMessage
} from '../../shared/plugins/plugin-host-protocol'

type PendingCompletion = {
  providerId: string
  resolve: (value: EditorCompletionResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type DiagnosticsListener = (providerId: string, publication: EditorDiagnosticsPublication) => void

export type PluginHostEditorTransport = {
  openDocument(providerId: string, document: EditorDocumentOpen): void
  changeDocument(providerId: string, change: EditorDocumentChange): void
  closeDocument(providerId: string, document: EditorDocumentClose): void
  requestCompletion(
    providerId: string,
    request: EditorCompletionRequest
  ): Promise<EditorCompletionResponse>
  cancelRequest(requestId: string): void
  onDiagnostics(callback: DiagnosticsListener): () => void
  handleChildMessage(message: PluginWorkerChildMessage): boolean
  rejectAll(reason: string): void
  inFlightCount(): number
}

export function createPluginHostEditorTransport(options: {
  send: (message: PluginWorkerParentMessage) => void
  isRunning: () => boolean
  timeoutMs: number
  tag: string
  markActivity: () => void
  log: (level: 'info' | 'warn' | 'error', line: string) => void
}): PluginHostEditorTransport {
  const pending = new Map<string, PendingCompletion>()
  const diagnosticsListeners = new Set<DiagnosticsListener>()

  function sendIfRunning(message: PluginWorkerParentMessage): void {
    if (options.isRunning()) {
      options.send(message)
    }
  }

  function rejectRequest(requestId: string, reason: string): void {
    const entry = pending.get(requestId)
    if (!entry) {
      return
    }
    clearTimeout(entry.timer)
    pending.delete(requestId)
    entry.reject(new Error(reason))
  }

  return {
    openDocument(providerId, document) {
      sendIfRunning({ type: 'editorDocumentOpen', providerId, document })
    },
    changeDocument(providerId, change) {
      sendIfRunning({ type: 'editorDocumentChange', providerId, change })
    },
    closeDocument(providerId, document) {
      sendIfRunning({ type: 'editorDocumentClose', providerId, document })
    },
    requestCompletion(providerId, request) {
      if (!options.isRunning()) {
        return Promise.reject(new Error(`${options.tag} worker is not running`))
      }
      if (pending.has(request.requestId)) {
        return Promise.reject(
          new Error(`${options.tag} duplicate editor request ${request.requestId}`)
        )
      }
      return new Promise<EditorCompletionResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.requestId)
          sendIfRunning({ type: 'editorCancelRequest', requestId: request.requestId })
          reject(
            new Error(
              `${options.tag} editor request ${request.requestId} timed out after ${options.timeoutMs}ms`
            )
          )
        }, options.timeoutMs)
        pending.set(request.requestId, { providerId, resolve, reject, timer })
        options.send({ type: 'editorCompletionRequest', providerId, request })
      })
    },
    cancelRequest(requestId) {
      sendIfRunning({ type: 'editorCancelRequest', requestId })
      rejectRequest(requestId, `${options.tag} editor request ${requestId} cancelled`)
    },
    onDiagnostics(callback) {
      diagnosticsListeners.add(callback)
      return () => diagnosticsListeners.delete(callback)
    },
    handleChildMessage(message) {
      if (message.type === 'editorCompletionResult') {
        const entry = pending.get(message.requestId)
        if (!entry) {
          return true
        }
        if (entry.providerId !== message.providerId) {
          options.log(
            'warn',
            `${options.tag} ignored editor result from unexpected provider ${message.providerId}`
          )
          return true
        }
        clearTimeout(entry.timer)
        pending.delete(message.requestId)
        options.markActivity()
        if (message.ok && message.response) {
          entry.resolve(message.response)
        } else {
          entry.reject(new Error(message.error ?? 'plugin editor completion failed'))
        }
        return true
      }
      if (message.type === 'editorDiagnostics') {
        options.markActivity()
        for (const listener of diagnosticsListeners) {
          listener(message.providerId, message.publication)
        }
        return true
      }
      return false
    },
    rejectAll(reason) {
      for (const requestId of pending.keys()) {
        rejectRequest(requestId, reason)
      }
    },
    inFlightCount: () => pending.size
  }
}
