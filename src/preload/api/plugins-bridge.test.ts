import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: mocks }))

import { pluginsApi } from './plugins-bridge'

const open = {
  documentId: 'doc-1',
  worktreeId: 'worktree-1',
  filePath: 'src/index.ts',
  languageId: 'typescript',
  version: 1,
  text: 'const value = 1'
}
const change = {
  documentId: 'doc-1',
  version: 2,
  changes: [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      rangeLength: 0,
      text: 'x'
    }
  ]
}
const completion = {
  requestId: 'req-1',
  documentId: 'doc-1',
  version: 2,
  position: { line: 0, character: 1 },
  context: { triggerKind: 'invoked' as const }
}

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.on.mockReset()
  mocks.removeListener.mockReset()
})

describe('pluginsApi editor bridge', () => {
  it('forwards neutral editor operations without owner authority fields', async () => {
    await pluginsApi.editorOpen(open)
    await pluginsApi.editorChange(change)
    await pluginsApi.editorClose({ documentId: 'doc-1', finalVersion: 2 })
    await pluginsApi.editorComplete(completion)
    await pluginsApi.editorCancel({ requestId: 'req-1' })

    expect(mocks.invoke.mock.calls).toEqual([
      ['plugins:editorOpen', open],
      ['plugins:editorChange', change],
      ['plugins:editorClose', { documentId: 'doc-1', finalVersion: 2 }],
      ['plugins:editorComplete', completion],
      ['plugins:editorCancel', { requestId: 'req-1' }]
    ])
  })

  it('subscribes and unsubscribes owner-scoped diagnostics', () => {
    const callback = vi.fn()
    const unsubscribe = pluginsApi.onEditorDiagnostics(callback)
    expect(mocks.on).toHaveBeenCalledWith('plugins:editorDiagnostics', expect.any(Function))
    const listener = mocks.on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void
    const payload = {
      ownerKey: 'renderer:1',
      publication: { documentId: 'doc-1', version: 1, diagnostics: [] }
    }
    listener({}, payload)
    expect(callback).toHaveBeenCalledWith(payload)
    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith('plugins:editorDiagnostics', listener)
  })
})
