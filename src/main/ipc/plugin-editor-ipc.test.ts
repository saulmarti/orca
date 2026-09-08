import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginService } from '../plugins/plugin-service'
import { registerPluginHandlers } from './plugins'

const electronMocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: electronMocks }))

type Handler = (event: { sender: TestSender }, args: unknown) => unknown
class TestSender extends EventEmitter {
  id: number
  send = vi.fn()
  constructor(id: number) {
    super()
    this.id = id
  }
}

function handler(channel: string): Handler {
  const call = electronMocks.handle.mock.calls.find(([name]) => name === channel)
  if (!call) {
    throw new Error(`missing IPC handler ${channel}`)
  }
  return call[1] as Handler
}

function document() {
  return {
    documentId: 'doc-1',
    worktreeId: 'worktree-1',
    filePath: 'src/index.ts',
    languageId: 'typescript',
    version: 1,
    text: 'const value = 1'
  }
}

function harness() {
  let diagnosticListener: ((event: unknown) => void) | null = null
  const editor = {
    open: vi.fn(async () => []),
    change: vi.fn(),
    close: vi.fn(),
    complete: vi.fn(async () => null),
    cancel: vi.fn(),
    revokeOwner: vi.fn()
  }
  const service = {
    setRuntimeDelegate: vi.fn(),
    refresh: vi.fn(async () => undefined),
    whenReady: vi.fn(async () => undefined),
    editor,
    onEditorDiagnostics: vi.fn((listener) => {
      diagnosticListener = listener
      return vi.fn()
    })
  } as unknown as PluginService
  const store = { onSettingsChanged: vi.fn(() => vi.fn()) } as never
  registerPluginHandlers(store, service, null)
  return { editor, emitDiagnostic: (event: unknown) => diagnosticListener?.(event) }
}

beforeEach(() => {
  electronMocks.handle.mockReset()
  electronMocks.on.mockReset()
})

describe('plugin editor IPC authority', () => {
  it('derives owner identity from sender and rejects renderer-supplied authority', async () => {
    const { editor } = harness()
    const sender = new TestSender(42)
    await handler('plugins:editorOpen')({ sender }, document())
    expect(editor.open).toHaveBeenCalledWith('renderer:42', document())

    await expect(
      handler('plugins:editorOpen')({ sender }, { ...document(), ownerKey: 'renderer:7' })
    ).rejects.toThrow()
    await expect(
      handler('plugins:editorOpen')({ sender }, { ...document(), version: 0 })
    ).rejects.toThrow()
  })

  it('revokes editor ownership when the sender is destroyed', async () => {
    const { editor } = harness()
    const sender = new TestSender(17)
    await handler('plugins:editorOpen')({ sender }, document())
    sender.emit('destroyed')
    expect(editor.revokeOwner).toHaveBeenCalledWith('renderer:17')
  })

  it('delivers diagnostics only to the owning renderer', async () => {
    const { emitDiagnostic } = harness()
    const first = new TestSender(1)
    const second = new TestSender(2)
    await handler('plugins:editorOpen')({ sender: first }, document())
    await handler('plugins:editorOpen')({ sender: second }, { ...document(), documentId: 'doc-2' })
    const event = {
      ownerKey: 'renderer:1',
      pluginKey: 'orca-samples.demo',
      providerId: 'typescript',
      features: ['diagnostics'],
      publication: { documentId: 'doc-1', version: 1, diagnostics: [] }
    }
    emitDiagnostic(event)
    expect(first.send).toHaveBeenCalledWith('plugins:editorDiagnostics', event)
    expect(second.send).not.toHaveBeenCalled()
    first.emit('destroyed')
    emitDiagnostic(event)
    expect(first.send).toHaveBeenCalledOnce()
  })
})
