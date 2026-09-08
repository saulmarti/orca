// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EditorCompletionRequest,
  EditorCompletionResponse,
  EditorDocumentOpen
} from '../../../../../shared/plugins/plugin-editor-protocol'
import type {
  EditorProviderBinding,
  RendererEditorDiagnosticsEvent
} from '../../../../../shared/plugins/plugin-editor-renderer-contract'
import { attachEditorPluginBridge } from './editor-plugin-bridge'

type MonacoChange = {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
  rangeLength: number
  text: string
}

type TestCompletionProvider = {
  provideCompletionItems(
    model: unknown,
    position: { lineNumber: number; column: number },
    context: { triggerKind: number; triggerCharacter?: string },
    token: {
      isCancellationRequested: boolean
      onCancellationRequested(listener: () => void): { dispose(): void }
    }
  ): Promise<{ suggestions: unknown[]; incomplete?: boolean }>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function harness() {
  let changeListener: ((event: { changes: MonacoChange[] }) => void) | null = null
  let diagnosticListener: ((event: RendererEditorDiagnosticsEvent) => void) | null = null
  let completionProvider: TestCompletionProvider | null = null
  const model = {
    getValue: vi.fn(() => 'const visible = 1'),
    getWordUntilPosition: vi.fn(() => ({ startColumn: 1, endColumn: 4 }))
  }
  const editorInstance = {
    getModel: vi.fn(() => model),
    onDidChangeModelContent: vi.fn((listener) => {
      changeListener = listener
      return { dispose: vi.fn() }
    })
  }
  const setModelMarkers = vi.fn()
  const completionDisposable = { dispose: vi.fn() }
  const monaco = {
    languages: {
      CompletionItemKind: { Text: 0, Function: 1 },
      CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
      registerCompletionItemProvider: vi.fn((_language, provider) => {
        completionProvider = provider
        return completionDisposable
      })
    },
    editor: { setModelMarkers },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 }
  }
  const plugins = {
    editorOpen: vi.fn(async (_args: EditorDocumentOpen): Promise<EditorProviderBinding[]> => [
      { pluginKey: 'acme.tools', providerId: 'typescript', features: ['completion', 'diagnostics'] }
    ]),
    editorChange: vi.fn(async () => undefined),
    editorClose: vi.fn(async () => undefined),
    editorComplete: vi.fn(
      async (request: EditorCompletionRequest): Promise<EditorCompletionResponse> => ({
        requestId: request.requestId,
        documentId: request.documentId,
        version: request.version,
        completion: {
          isIncomplete: false,
          items: [{ label: 'fixtureCompletion', kind: 'function' }]
        }
      })
    ),
    editorCancel: vi.fn(async () => undefined),
    onEditorDiagnostics: vi.fn((listener) => {
      diagnosticListener = listener
      return vi.fn()
    })
  }
  ;(window as unknown as { api: { plugins: typeof plugins } }).api = { plugins }
  const bridge = attachEditorPluginBridge({
    editorInstance: editorInstance as never,
    monaco: monaco as never,
    worktreeId: 'worktree-1',
    filePath: 'src/index.ts',
    languageId: 'typescript'
  })
  return {
    bridge,
    plugins,
    model,
    monaco,
    setModelMarkers,
    completionDisposable,
    change: (changes: MonacoChange[]) => changeListener?.({ changes }),
    diagnostic: (event: RendererEditorDiagnosticsEvent) => diagnosticListener?.(event),
    provider: (): TestCompletionProvider => {
      if (!completionProvider) {
        throw new Error('completion provider was not registered')
      }
      return completionProvider
    }
  }
}

function token() {
  let cancel: (() => void) | null = null
  return {
    value: {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        cancel = listener
        return { dispose: vi.fn() }
      }
    },
    cancel: () => cancel?.()
  }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('attachEditorPluginBridge', () => {
  it('opens visible text at v1 and preserves ordered incremental changes', async () => {
    const h = harness()
    expect(h.plugins.editorOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'worktree-1',
        filePath: 'src/index.ts',
        languageId: 'typescript',
        version: 1,
        text: 'const visible = 1'
      })
    )
    const documentId = h.plugins.editorOpen.mock.calls[0]?.[0].documentId
    h.change([
      {
        range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4 },
        rangeLength: 2,
        text: 'xx'
      }
    ])
    await flush()
    expect(h.plugins.editorChange).toHaveBeenCalledWith({
      documentId,
      version: 2,
      changes: [
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
          rangeLength: 2,
          text: 'xx'
        }
      ]
    })
  })

  it('captures current version for completions and suppresses stale results', async () => {
    const h = harness()
    await flush()
    const pending = deferred<EditorCompletionResponse>()
    h.plugins.editorComplete.mockImplementationOnce(() => pending.promise)
    const currentToken = token()
    const result = h
      .provider()
      .provideCompletionItems(
        h.model,
        { lineNumber: 1, column: 4 },
        { triggerKind: 0 },
        currentToken.value
      )
    await vi.waitFor(() => expect(h.plugins.editorComplete).toHaveBeenCalledOnce())
    const request = h.plugins.editorComplete.mock.calls[0]![0]
    expect(request.version).toBe(1)
    h.change([
      {
        range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 4 },
        rangeLength: 0,
        text: 'x'
      }
    ])
    pending.resolve({
      requestId: request.requestId,
      documentId: request.documentId,
      version: request.version,
      completion: { isIncomplete: false, items: [{ label: 'stale' }] }
    })
    await expect(result).resolves.toEqual({ suggestions: [] })
  })

  it('sends cancellation exactly once and suppresses the late completion', async () => {
    const h = harness()
    await flush()
    const pending = deferred<EditorCompletionResponse>()
    h.plugins.editorComplete.mockImplementationOnce(() => pending.promise)
    const currentToken = token()
    const result = h
      .provider()
      .provideCompletionItems(
        h.model,
        { lineNumber: 1, column: 4 },
        { triggerKind: 0 },
        currentToken.value
      )
    await vi.waitFor(() => expect(h.plugins.editorComplete).toHaveBeenCalledOnce())
    const request = h.plugins.editorComplete.mock.calls[0]![0]
    currentToken.cancel()
    currentToken.cancel()
    expect(h.plugins.editorCancel).toHaveBeenCalledTimes(1)
    expect(h.plugins.editorCancel).toHaveBeenCalledWith({ requestId: request.requestId })
    pending.resolve({
      requestId: request.requestId,
      documentId: request.documentId,
      version: 1,
      completion: { isIncomplete: false, items: [{ label: 'late' }] }
    })
    await expect(result).resolves.toEqual({ suggestions: [] })
  })

  it('applies current diagnostics and clears markers/close on dispose', async () => {
    const h = harness()
    await flush()
    const opened = h.plugins.editorOpen.mock.calls[0]![0]
    h.diagnostic({
      ownerKey: 'renderer:1',
      pluginKey: 'acme.tools',
      providerId: 'typescript',
      features: ['diagnostics'],
      publication: {
        documentId: opened.documentId,
        version: 1,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
            severity: 'error',
            message: 'fixture error'
          }
        ]
      }
    })
    expect(h.setModelMarkers).toHaveBeenCalledWith(
      h.model,
      'plugin:acme.tools:typescript',
      expect.any(Array)
    )
    h.bridge.dispose()
    await flush()
    expect(h.completionDisposable.dispose).toHaveBeenCalledOnce()
    expect(h.setModelMarkers).toHaveBeenLastCalledWith(h.model, 'plugin:acme.tools:typescript', [])
    expect(h.plugins.editorClose).toHaveBeenCalledWith({
      documentId: opened.documentId,
      finalVersion: 1
    })
  })
})
