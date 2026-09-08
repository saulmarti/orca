import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processMocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('node:child_process', () => ({ fork: processMocks.fork }))

import { startPluginWorker } from './plugin-host-process'

class FakeChild extends EventEmitter {
  connected = true
  stdout = new PassThrough()
  stderr = new PassThrough()
  send = vi.fn()
  kill = vi.fn()
}

function start(child: FakeChild, options: { eventTimeoutMs?: number } = {}) {
  processMocks.fork.mockReturnValue(child)
  return startPluginWorker({
    pluginId: 'orca-samples.demo',
    rootDir: '/plugin',
    mainEntry: 'worker.js',
    entryPath: '/host.js',
    grantedCapabilities: [],
    executeHostCall: async () => ({ ok: true, value: null }),
    log: vi.fn(),
    ...options
  })
}

beforeEach(() => {
  processMocks.fork.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startPluginWorker', () => {
  it('does not inherit Orca execArgv', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [] })
    await pending

    expect(processMocks.fork).toHaveBeenCalledWith(
      '/host.js',
      [],
      expect.objectContaining({ execArgv: [] })
    )
  })

  it('replays an exit that happened before handle registration', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: ['run'] })
    const handle = await pending
    child.emit('exit', 23)
    const onExit = vi.fn()

    handle.onExit(onExit)

    expect(onExit).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledWith(23)
  })

  it('kills a live worker that disconnects its IPC channel', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: ['run'] })
    const handle = await pending
    const command = handle.invokeCommand('run')
    child.connected = false

    child.emit('disconnect')

    await expect(command).rejects.toThrow('disconnected')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('counts delivered events as in flight until their acknowledgement', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [] })
    const handle = await pending

    handle.deliverEvent('worktree.created', {
      worktreeId: 'worktree-1',
      path: '/repo',
      branch: 'feature'
    })

    expect(handle.inFlightCount()).toBe(1)
    child.emit('message', { type: 'eventAck', eventId: 0 })
    expect(handle.inFlightCount()).toBe(0)
  })

  it('kills a worker whose event handler never acknowledges completion', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const pending = start(child, { eventTimeoutMs: 25 })
    child.emit('message', { type: 'ready', commands: [] })
    const handle = await pending

    handle.deliverEvent('worktree.created', {
      worktreeId: 'worktree-1',
      path: '/repo',
      branch: 'feature'
    })
    await vi.advanceTimersByTimeAsync(25)

    expect(handle.inFlightCount()).toBe(0)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills a worker that exceeds the pending event cap', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [] })
    const handle = await pending

    for (let index = 0; index < 65; index += 1) {
      handle.deliverEvent('agent.status.changed', {
        worktreeId: null,
        paneKey: `pane-${index}`,
        state: 'working',
        receivedAt: Date.now()
      })
    }

    expect(handle.inFlightCount()).toBe(64)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})

const editorRequest = {
  requestId: 'req-1',
  documentId: 'doc-1',
  version: 2,
  position: { line: 0, character: 3 },
  context: { triggerKind: 'invoked' as const }
}

const editorResponse = {
  requestId: 'req-1',
  documentId: 'doc-1',
  version: 2,
  completion: { isIncomplete: false, items: [{ label: 'fixtureCompletion' }] }
}

describe('startPluginWorker editor transport', () => {
  it('surfaces registered editor providers from ready', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [], editorProviders: ['typescript'] })
    const handle = await pending

    expect(handle.editorProviders).toEqual(['typescript'])
  })

  it('correlates editor completion responses', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [], editorProviders: ['typescript'] })
    const handle = await pending

    const completion = handle.requestEditorCompletion('typescript', editorRequest)
    expect(child.send).toHaveBeenCalledWith({
      type: 'editorCompletionRequest',
      providerId: 'typescript',
      request: editorRequest
    })
    child.emit('message', {
      type: 'editorCompletionResult',
      providerId: 'typescript',
      requestId: 'req-1',
      ok: true,
      response: editorResponse
    })

    await expect(completion).resolves.toEqual(editorResponse)
  })

  it('cancels an in-flight editor completion promptly', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [], editorProviders: ['typescript'] })
    const handle = await pending

    const completion = handle.requestEditorCompletion('typescript', editorRequest)
    handle.cancelEditorRequest('req-1')

    expect(child.send).toHaveBeenCalledWith({ type: 'editorCancelRequest', requestId: 'req-1' })
    await expect(completion).rejects.toThrow('cancelled')
  })

  it('fans diagnostics out to active subscribers', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [], editorProviders: ['typescript'] })
    const handle = await pending
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = handle.onEditorDiagnostics(first)
    handle.onEditorDiagnostics(second)
    const publication = { documentId: 'doc-1', version: 2, diagnostics: [] }

    child.emit('message', {
      type: 'editorDiagnostics',
      providerId: 'typescript',
      publication
    })

    expect(first).toHaveBeenCalledWith('typescript', publication)
    expect(second).toHaveBeenCalledWith('typescript', publication)
    unsubscribe()
    child.emit('message', {
      type: 'editorDiagnostics',
      providerId: 'typescript',
      publication
    })
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledTimes(2)
  })
})
