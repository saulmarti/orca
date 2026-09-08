import type { OnMount } from '@monaco-editor/react'
import type { languages } from 'monaco-editor'
import type {
  EditorCompletionRequest,
  EditorDocumentChange
} from '../../../../../shared/plugins/plugin-editor-protocol'
import { toEditorPosition, toEditorRange } from './editor-plugin-position'
import { toMonacoCompletionItem } from './editor-plugin-monaco-completions'
import {
  applyEditorPluginDiagnostics,
  editorPluginMarkerOwner
} from './editor-plugin-monaco-diagnostics'

type MonacoEditor = Parameters<OnMount>[0]
type MonacoApi = Parameters<OnMount>[1]

let documentSequence = 0
let requestSequence = 0

function nextDocumentId(): string {
  documentSequence += 1
  return `plugin-editor-document-${documentSequence}`
}

function nextRequestId(documentId: string): string {
  requestSequence += 1
  return `${documentId}:completion:${requestSequence}`
}

function completionTrigger(
  monaco: MonacoApi,
  context: languages.CompletionContext
): EditorCompletionRequest['context'] {
  if (context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter) {
    return { triggerKind: 'triggerCharacter', triggerCharacter: context.triggerCharacter ?? '' }
  }
  if (
    context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerForIncompleteCompletions
  ) {
    return { triggerKind: 'triggerForIncompleteCompletions' }
  }
  return { triggerKind: 'invoked' }
}

export function attachEditorPluginBridge(args: {
  editorInstance: MonacoEditor
  monaco: MonacoApi
  worktreeId: string
  filePath: string
  languageId: string
}): { dispose(): void } {
  const { editorInstance, monaco, worktreeId, filePath, languageId } = args
  const model = editorInstance.getModel()
  if (!model) {
    return { dispose() {} }
  }

  const plugins = window.api.plugins
  const documentId = nextDocumentId()
  let version = 1
  let disposed = false
  let openSucceeded = false
  const pendingRequests = new Set<string>()
  const markerOwners = new Set<string>()

  let syncChain: Promise<void> = plugins
    .editorOpen({
      documentId,
      worktreeId,
      filePath,
      languageId,
      version,
      text: model.getValue()
    })
    .then(() => {
      openSucceeded = true
    })
    .catch(() => undefined)

  const contentSub = editorInstance.onDidChangeModelContent((event) => {
    if (disposed) {
      return
    }
    version += 1
    const change: EditorDocumentChange = {
      documentId,
      version,
      changes: event.changes.map((item) => ({
        range: toEditorRange(item.range),
        rangeLength: item.rangeLength,
        text: item.text
      }))
    }
    syncChain = syncChain
      .then(() => (openSucceeded ? plugins.editorChange(change) : undefined))
      .then(() => undefined)
      .catch(() => undefined)
  })

  const diagnosticsUnsubscribe = plugins.onEditorDiagnostics((event) => {
    if (disposed) {
      return
    }
    if (applyEditorPluginDiagnostics(monaco, model, event, documentId, version)) {
      markerOwners.add(editorPluginMarkerOwner(event.pluginKey, event.providerId))
    }
  })

  const completionDisposable = monaco.languages.registerCompletionItemProvider(languageId, {
    async provideCompletionItems(candidateModel, position, context, token) {
      if (disposed || candidateModel !== model) {
        return { suggestions: [] }
      }
      const requestVersion = version
      const requestId = nextRequestId(documentId)
      const request: EditorCompletionRequest = {
        requestId,
        documentId,
        version: requestVersion,
        position: toEditorPosition(position),
        context: completionTrigger(monaco, context)
      }
      let cancelled = false
      pendingRequests.add(requestId)
      const cancel = (): void => {
        if (cancelled || !pendingRequests.has(requestId)) {
          return
        }
        cancelled = true
        pendingRequests.delete(requestId)
        void plugins.editorCancel({ requestId })
      }
      const cancellationSub = token.onCancellationRequested(cancel)
      if (token.isCancellationRequested) {
        cancel()
      }
      try {
        await syncChain
        if (cancelled || disposed || !openSucceeded || version !== requestVersion) {
          return { suggestions: [] }
        }
        const response = await plugins.editorComplete(request).catch(() => null)
        if (
          cancelled ||
          disposed ||
          version !== requestVersion ||
          !response ||
          response.requestId !== requestId ||
          response.documentId !== documentId ||
          response.version !== requestVersion
        ) {
          return { suggestions: [] }
        }
        return {
          suggestions: response.completion.items.map((item) =>
            toMonacoCompletionItem(monaco, model, position, item)
          ),
          incomplete: response.completion.isIncomplete
        }
      } finally {
        pendingRequests.delete(requestId)
        cancellationSub.dispose()
      }
    }
  })

  return {
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      contentSub.dispose()
      completionDisposable.dispose()
      diagnosticsUnsubscribe()
      for (const requestId of pendingRequests) {
        void plugins.editorCancel({ requestId })
      }
      pendingRequests.clear()
      for (const owner of markerOwners) {
        monaco.editor.setModelMarkers(model, owner, [])
      }
      void syncChain.then(() => {
        if (openSucceeded) {
          return plugins.editorClose({ documentId, finalVersion: version })
        }
        return undefined
      })
    }
  }
}
