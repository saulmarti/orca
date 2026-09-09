import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EditorCompletionRequest,
  EditorDocumentChange,
  EditorDocumentOpen
} from '../../../src/shared/plugins/plugin-editor-protocol'
import activate from './index'

type Provider = {
  openDocument?(document: EditorDocumentOpen): void | Promise<void>
  changeDocument?(change: EditorDocumentChange): void | Promise<void>
  closeDocument?(document: { documentId: string; finalVersion: number }): void | Promise<void>
  provideCompletions?(request: EditorCompletionRequest, signal: AbortSignal): unknown
}

const files: Record<string, string> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022' },
    include: ['src/**/*.ts']
  }),
  'src/user.ts': 'export interface User { name: string }'
}

function directoryEntries(path: string): { name: string; path: string }[] {
  const prefix = path ? `${path}/` : ''
  const names = new Set<string>()
  for (const filePath of Object.keys(files)) {
    if (!filePath.startsWith(prefix)) {
      continue
    }
    const remainder = filePath.slice(prefix.length)
    const name = remainder.split('/')[0]!
    names.add(name)
  }
  return [...names].map((name) => ({ name, path: prefix + name }))
}

function createOrca() {
  let provider: Provider | undefined
  const publishDiagnostics = vi.fn()
  const hostCall = vi.fn(async (method: string, params: unknown) => {
    if (method === 'workspace.readDirectory') {
      const { path } = params as { path: string }
      return { path, status: 'ok', entries: directoryEntries(path) }
    }
    if (method === 'workspace.statFiles') {
      const { paths } = params as { paths: string[] }
      return {
        results: paths.map((path: string) => {
          if (path in files) {
            const text = files[path]!
            return {
              path,
              status: 'ok',
              type: 'file',
              byteLength: Buffer.byteLength(text),
              mtimeMs: 1
            }
          }
          const directory = directoryEntries(path).length > 0
          return directory
            ? { path, status: 'ok', type: 'directory', byteLength: 0, mtimeMs: 1 }
            : { path, status: 'missing' }
        })
      }
    }
    if (method === 'workspace.readFiles') {
      const { paths } = params as { paths: string[] }
      return {
        results: paths.map((path: string) =>
          path in files
            ? {
                path,
                status: 'ok',
                content: files[path],
                byteLength: Buffer.byteLength(files[path]!),
                mtimeMs: 1
              }
            : { path, status: 'missing' }
        )
      }
    }
    throw new Error(`unexpected host method ${method}`)
  })

  const orca = {
    editor: {
      registerProvider: vi.fn((_id: string, value: Provider) => {
        provider = value
        return { dispose: vi.fn() }
      }),
      publishDiagnostics
    },
    host: { call: hostCall },
    grantedCapabilities: ['editor:languageService', 'workspace:readFiles'],
    log: vi.fn()
  }
  return { orca, getProvider: () => provider, publishDiagnostics, hostCall }
}

describe('orca-typescript worker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('hydrates a configured project and serves completions plus versioned diagnostics', async () => {
    const harness = createOrca()
    await activate(harness.orca as never)
    const provider = harness.getProvider()
    expect(provider).toBeDefined()

    const text = "import type { User } from './user'\ndeclare const user: User\nuser.na"
    const document: EditorDocumentOpen = {
      documentId: 'doc-1',
      worktreeId: 'wt-1',
      filePath: '/repo/src/example.ts',
      relativePath: 'src/example.ts',
      languageId: 'typescript',
      version: 1,
      text
    }

    await provider?.openDocument?.(document)
    const completion = (await provider?.provideCompletions?.(
      {
        requestId: 'req-1',
        documentId: 'doc-1',
        version: 1,
        position: { line: 2, character: 7 },
        context: { triggerKind: 'invoked' }
      },
      new AbortController().signal
    )) as { items: { label: string }[] }
    expect(completion.items.some((item) => item.label === 'name')).toBe(true)

    await provider?.changeDocument?.({
      documentId: 'doc-1',
      version: 2,
      changes: [
        {
          range: { start: { line: 2, character: 7 }, end: { line: 2, character: 7 } },
          rangeLength: 0,
          text: "me\nconst count: number = 'wrong'"
        }
      ]
    } as never)
    await vi.advanceTimersByTimeAsync(300)
    expect(harness.publishDiagnostics).toHaveBeenCalledWith(
      'typescript',
      expect.objectContaining({
        documentId: 'doc-1',
        version: 2,
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: '2322' })])
      })
    )

    await provider?.changeDocument?.({
      documentId: 'doc-1',
      version: 3,
      changes: [
        {
          range: { start: { line: 3, character: 22 }, end: { line: 3, character: 29 } },
          rangeLength: 7,
          text: '1'
        }
      ]
    } as never)
    await vi.advanceTimersByTimeAsync(300)
    expect(harness.publishDiagnostics).toHaveBeenLastCalledWith('typescript', {
      documentId: 'doc-1',
      version: 3,
      diagnostics: []
    })

    await provider?.closeDocument?.({ documentId: 'doc-1', finalVersion: 3 })
    const afterClose = (await provider?.provideCompletions?.(
      {
        requestId: 'req-2',
        documentId: 'doc-1',
        version: 3,
        position: { line: 0, character: 0 },
        context: { triggerKind: 'invoked' }
      },
      new AbortController().signal
    )) as { items: unknown[] }
    expect(afterClose.items).toEqual([])
  })
})
