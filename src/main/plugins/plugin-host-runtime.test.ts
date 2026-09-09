import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPluginWorkerRuntime, type PluginWorkerOrcaApi } from './plugin-host-runtime'

describe('plugin worker shutdown', () => {
  it('normalizes either manifest separator before importing the worker', async () => {
    const importModule = vi.fn(async () => ({ default: vi.fn() }))
    const runtime = createPluginWorkerRuntime({ send: vi.fn(), importModule })

    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: join('plugin-root'),
      mainEntry: 'nested\\worker.js',
      grantedCapabilities: []
    })

    expect(importModule).toHaveBeenCalledWith(
      pathToFileURL(join('plugin-root', 'nested', 'worker.js')).href
    )
  })

  it('awaits an optional deactivate export before exiting', async () => {
    let finishDeactivate!: () => void
    const deactivate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDeactivate = resolve
        })
    )
    const send = vi.fn()
    const exit = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      exit,
      importModule: async () => ({ default: vi.fn(), deactivate })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: []
    })

    const shutdown = runtime.handleMessage({ type: 'shutdown' })
    await Promise.resolve()
    expect(deactivate).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
    finishDeactivate()
    await shutdown

    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits immediately when the plugin has no deactivate export', async () => {
    const exit = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send: vi.fn(),
      exit,
      importModule: async () => ({ default: vi.fn() })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: []
    })

    await runtime.handleMessage({ type: 'shutdown' })

    expect(exit).toHaveBeenCalledWith(0)
  })
})

describe('plugin worker editor API', () => {
  const initMessage = {
    type: 'init' as const,
    pluginId: 'orca-samples.demo',
    pluginRoot: '/plugin',
    mainEntry: 'worker.js',
    grantedCapabilities: ['editor:languageService']
  }
  const document = {
    documentId: 'doc-1',
    worktreeId: 'worktree-1',
    filePath: 'src/index.ts',
    relativePath: 'src/index.ts',
    languageId: 'typescript',
    version: 1,
    text: 'const value = 1'
  }
  const completionRequest = {
    requestId: 'req-1',
    documentId: 'doc-1',
    version: 2,
    position: { line: 0, character: 5 },
    context: { triggerKind: 'invoked' as const }
  }

  it('reports registered editor providers when the worker becomes ready', async () => {
    const send = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      importModule: async () => ({
        default: (orca: PluginWorkerOrcaApi) => {
          orca.editor.registerProvider('typescript', {})
        }
      })
    })

    await runtime.handleMessage(initMessage)

    expect(send).toHaveBeenCalledWith({
      type: 'ready',
      commands: [],
      editorProviders: ['typescript']
    })
  })

  it('delivers document changes after earlier provider work completes', async () => {
    let releaseOpen!: () => void
    const calls: string[] = []
    const runtime = createPluginWorkerRuntime({
      send: vi.fn(),
      importModule: async () => ({
        default: (orca: PluginWorkerOrcaApi) => {
          orca.editor.registerProvider('typescript', {
            async openDocument() {
              calls.push('open:start')
              await new Promise<void>((resolve) => {
                releaseOpen = resolve
              })
              calls.push('open:end')
            },
            changeDocument() {
              calls.push('change')
            }
          })
        }
      })
    })
    await runtime.handleMessage(initMessage)

    const opening = runtime.handleMessage({
      type: 'editorDocumentOpen',
      providerId: 'typescript',
      document
    })
    const changing = runtime.handleMessage({
      type: 'editorDocumentChange',
      providerId: 'typescript',
      change: {
        documentId: 'doc-1',
        version: 2,
        changes: [
          {
            range: { start: { line: 0, character: 14 }, end: { line: 0, character: 15 } },
            rangeLength: 1,
            text: '2'
          }
        ]
      }
    })
    await Promise.resolve()
    expect(calls).toEqual(['open:start'])
    releaseOpen()
    await Promise.all([opening, changing])

    expect(calls).toEqual(['open:start', 'open:end', 'change'])
  })

  it('returns completions with request and document correlation', async () => {
    const send = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      importModule: async () => ({
        default: (orca: PluginWorkerOrcaApi) => {
          orca.editor.registerProvider('typescript', {
            provideCompletions() {
              return { isIncomplete: false, items: [{ label: 'fixtureCompletion' }] }
            }
          })
        }
      })
    })
    await runtime.handleMessage(initMessage)

    await runtime.handleMessage({
      type: 'editorCompletionRequest',
      providerId: 'typescript',
      request: completionRequest
    })

    expect(send).toHaveBeenCalledWith({
      type: 'editorCompletionResult',
      providerId: 'typescript',
      requestId: 'req-1',
      ok: true,
      response: {
        requestId: 'req-1',
        documentId: 'doc-1',
        version: 2,
        completion: { isIncomplete: false, items: [{ label: 'fixtureCompletion' }] }
      }
    })
  })

  it('aborts a completion and suppresses its late result', async () => {
    let signal!: AbortSignal
    let finish!: () => void
    const send = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      importModule: async () => ({
        default: (orca: PluginWorkerOrcaApi) => {
          orca.editor.registerProvider('typescript', {
            provideCompletions(_request: unknown, abortSignal: AbortSignal) {
              signal = abortSignal
              return new Promise((resolve) => {
                finish = () => resolve({ isIncomplete: false, items: [{ label: 'late' }] })
              })
            }
          })
        }
      })
    })
    await runtime.handleMessage(initMessage)

    const completion = runtime.handleMessage({
      type: 'editorCompletionRequest',
      providerId: 'typescript',
      request: completionRequest
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await runtime.handleMessage({ type: 'editorCancelRequest', requestId: 'req-1' })

    expect(signal.aborted).toBe(true)
    finish()
    await completion
    expect(send.mock.calls.some(([message]) => message.type === 'editorCompletionResult')).toBe(
      false
    )
  })

  it('publishes diagnostics with explicit provider identity', async () => {
    let publishDiagnostics!: PluginWorkerOrcaApi['editor']['publishDiagnostics']
    const send = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      importModule: async () => ({
        default: (orca: PluginWorkerOrcaApi) => {
          publishDiagnostics = orca.editor.publishDiagnostics
          orca.editor.registerProvider('typescript', {})
        }
      })
    })
    await runtime.handleMessage(initMessage)

    publishDiagnostics('typescript', {
      documentId: 'doc-1',
      version: 2,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          severity: 'error',
          message: 'fixture error'
        }
      ]
    })

    expect(send).toHaveBeenCalledWith({
      type: 'editorDiagnostics',
      providerId: 'typescript',
      publication: expect.objectContaining({ documentId: 'doc-1', version: 2 })
    })
  })

  it('aborts pending completions before plugin deactivate runs', async () => {
    let signal!: AbortSignal
    const deactivate = vi.fn(() => {
      expect(signal.aborted).toBe(true)
    })
    const runtime = createPluginWorkerRuntime({
      send: vi.fn(),
      exit: vi.fn(),
      importModule: async () => ({
        default: (orca: PluginWorkerOrcaApi) => {
          orca.editor.registerProvider('typescript', {
            provideCompletions(_request: unknown, abortSignal: AbortSignal) {
              signal = abortSignal
              return new Promise((resolve) => {
                abortSignal.addEventListener(
                  'abort',
                  () => resolve({ isIncomplete: false, items: [] }),
                  { once: true }
                )
              })
            }
          })
        },
        deactivate
      })
    })
    await runtime.handleMessage(initMessage)
    const completion = runtime.handleMessage({
      type: 'editorCompletionRequest',
      providerId: 'typescript',
      request: completionRequest
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(signal).toBeDefined()

    await runtime.handleMessage({ type: 'shutdown' })
    await completion

    expect(deactivate).toHaveBeenCalledOnce()
  })
})
