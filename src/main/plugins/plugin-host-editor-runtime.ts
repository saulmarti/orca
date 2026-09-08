import {
  editorCompletionResponseSchema,
  editorDiagnosticsPublicationSchema,
  type EditorCompletionList,
  type EditorCompletionRequest,
  type EditorDiagnosticsPublication,
  type EditorDocumentChange,
  type EditorDocumentClose,
  type EditorDocumentOpen
} from '../../shared/plugins/plugin-editor-protocol'
import type { PluginWorkerChildMessage } from '../../shared/plugins/plugin-host-protocol'
import { pluginIdSchema } from '../../shared/plugins/plugin-manifest-fields'

export type PluginDisposable = { dispose(): void }

export type PluginEditorProvider = {
  openDocument?(document: EditorDocumentOpen): void | Promise<void>
  changeDocument?(change: EditorDocumentChange): void | Promise<void>
  closeDocument?(document: EditorDocumentClose): void | Promise<void>
  provideCompletions?(
    request: EditorCompletionRequest,
    signal: AbortSignal
  ): EditorCompletionList | Promise<EditorCompletionList>
}

export type PluginWorkerEditorApi = {
  registerProvider(providerId: string, provider: PluginEditorProvider): PluginDisposable
  publishDiagnostics(providerId: string, publication: EditorDiagnosticsPublication): void
}

type PendingEditorRequest = {
  providerId: string
  controller: AbortController
}

export type PluginHostEditorRuntime = {
  api: PluginWorkerEditorApi
  providerIds(): string[]
  openDocument(providerId: string, document: EditorDocumentOpen): Promise<void>
  changeDocument(providerId: string, change: EditorDocumentChange): Promise<void>
  closeDocument(providerId: string, document: EditorDocumentClose): Promise<void>
  complete(providerId: string, request: EditorCompletionRequest): Promise<void>
  cancel(requestId: string): void
  abortAll(): void
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

function validateProvider(provider: PluginEditorProvider): void {
  if (!provider || typeof provider !== 'object') {
    throw new Error('editor provider must be an object')
  }
  for (const key of [
    'openDocument',
    'changeDocument',
    'closeDocument',
    'provideCompletions'
  ] as const) {
    if (provider[key] !== undefined && typeof provider[key] !== 'function') {
      throw new Error(`editor provider ${key} must be a function`)
    }
  }
}

export function createPluginHostEditorRuntime(options: {
  send: (message: PluginWorkerChildMessage) => void
  grantedCapabilities: readonly string[]
}): PluginHostEditorRuntime {
  const providers = new Map<string, PluginEditorProvider>()
  const queues = new Map<string, Promise<void>>()
  const pendingRequests = new Map<string, PendingEditorRequest>()
  let shuttingDown = false

  function requireCapability(): void {
    if (!options.grantedCapabilities.includes('editor:languageService')) {
      throw new Error('editor:languageService capability is not granted')
    }
  }

  function enqueue(
    providerId: string,
    operation: (provider: PluginEditorProvider) => void | Promise<void>
  ): Promise<void> {
    const provider = providers.get(providerId)
    if (!provider) {
      options.send({
        type: 'log',
        level: 'warn',
        message: `ignoring editor message for unregistered provider ${providerId}`
      })
      return Promise.resolve()
    }
    const previous = queues.get(providerId) ?? Promise.resolve()
    const current = previous
      .then(() => operation(provider))
      .catch((error) => {
        options.send({ type: 'log', level: 'error', message: errorText(error).slice(0, 8192) })
      })
    queues.set(providerId, current)
    return current.finally(() => {
      if (queues.get(providerId) === current) {
        queues.delete(providerId)
      }
    })
  }

  async function complete(providerId: string, request: EditorCompletionRequest): Promise<void> {
    const provider = providers.get(providerId)
    if (!provider?.provideCompletions) {
      options.send({
        type: 'editorCompletionResult',
        providerId,
        requestId: request.requestId,
        ok: false,
        error: `no completion handler registered for editor provider ${providerId}`
      })
      return
    }
    if (pendingRequests.has(request.requestId)) {
      options.send({
        type: 'editorCompletionResult',
        providerId,
        requestId: request.requestId,
        ok: false,
        error: `duplicate editor request id ${request.requestId}`
      })
      return
    }

    const pending: PendingEditorRequest = { providerId, controller: new AbortController() }
    pendingRequests.set(request.requestId, pending)
    try {
      await (queues.get(providerId) ?? Promise.resolve())
      if (pending.controller.signal.aborted || shuttingDown) {
        return
      }
      const completion = await provider.provideCompletions(request, pending.controller.signal)
      if (pending.controller.signal.aborted || shuttingDown) {
        return
      }
      const response = editorCompletionResponseSchema.safeParse({
        requestId: request.requestId,
        documentId: request.documentId,
        version: request.version,
        completion
      })
      if (!response.success) {
        options.send({
          type: 'editorCompletionResult',
          providerId,
          requestId: request.requestId,
          ok: false,
          error: `invalid completion result: ${response.error.issues[0]?.message ?? 'invalid payload'}`
        })
        return
      }
      options.send({
        type: 'editorCompletionResult',
        providerId,
        requestId: request.requestId,
        ok: true,
        response: response.data
      })
    } catch (error) {
      if (!pending.controller.signal.aborted && !shuttingDown) {
        options.send({
          type: 'editorCompletionResult',
          providerId,
          requestId: request.requestId,
          ok: false,
          error: errorText(error).slice(0, 8192)
        })
      }
    } finally {
      if (pendingRequests.get(request.requestId) === pending) {
        pendingRequests.delete(request.requestId)
      }
    }
  }

  const api: PluginWorkerEditorApi = {
    registerProvider(providerId, provider) {
      requireCapability()
      const parsedId = pluginIdSchema.safeParse(providerId)
      if (!parsedId.success) {
        throw new Error(`invalid editor provider id: ${providerId}`)
      }
      validateProvider(provider)
      if (providers.has(parsedId.data)) {
        throw new Error(`duplicate editor provider registration: ${parsedId.data}`)
      }
      providers.set(parsedId.data, provider)
      let disposed = false
      return {
        dispose() {
          if (disposed) {
            return
          }
          disposed = true
          if (providers.get(parsedId.data) === provider) {
            providers.delete(parsedId.data)
          }
          for (const [requestId, pending] of pendingRequests) {
            if (pending.providerId === parsedId.data) {
              pending.controller.abort()
              pendingRequests.delete(requestId)
            }
          }
        }
      }
    },
    publishDiagnostics(providerId, publication) {
      requireCapability()
      if (!providers.has(providerId)) {
        throw new Error(`editor provider ${providerId} is not registered`)
      }
      const parsed = editorDiagnosticsPublicationSchema.safeParse(publication)
      if (!parsed.success) {
        throw new Error(
          `invalid editor diagnostics: ${parsed.error.issues[0]?.message ?? 'invalid payload'}`
        )
      }
      options.send({ type: 'editorDiagnostics', providerId, publication: parsed.data })
    }
  }

  return {
    api,
    providerIds: () => [...providers.keys()],
    openDocument: (providerId, document) =>
      enqueue(providerId, (provider) => provider.openDocument?.(document)),
    changeDocument: (providerId, change) =>
      enqueue(providerId, (provider) => provider.changeDocument?.(change)),
    closeDocument: (providerId, document) =>
      enqueue(providerId, (provider) => provider.closeDocument?.(document)),
    complete,
    cancel(requestId) {
      pendingRequests.get(requestId)?.controller.abort()
    },
    abortAll() {
      shuttingDown = true
      for (const pending of pendingRequests.values()) {
        pending.controller.abort()
      }
      pendingRequests.clear()
    }
  }
}
