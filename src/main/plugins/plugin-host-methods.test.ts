import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../shared/plugins/plugin-host-api'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'
import { pluginEditorWorktreeLeases } from './plugin-editor-worktree-leases'
import { AgentSessionPtyWriteRefusedError } from '../../shared/agent-session-pty-write-admission'
import {
  PLUGIN_WORKSPACE_DIRECTORY_ENTRY_LIMIT,
  PLUGIN_WORKSPACE_FILE_MAX_BYTES
} from '../../shared/plugins/plugin-workspace-file-api'

function createServices(storageSet: PluginHostServices['storage']['set']): PluginHostServices {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    hasEditorWorktreeLease: vi.fn().mockReturnValue(false),
    readPluginWorkspaceDirectory: vi
      .fn()
      .mockResolvedValue({ path: '', status: 'ok', entries: [] }),
    statPluginWorkspaceFiles: vi.fn().mockResolvedValue([]),
    readPluginWorkspaceFiles: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: {
      get: vi.fn(),
      set: storageSet,
      delete: vi.fn(),
      keys: vi.fn().mockReturnValue([])
    },
    secrets: {
      get: vi.fn().mockReturnValue({ ok: true, value: null }),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn()
    },
    settings: {
      getAll: vi.fn().mockReturnValue({}),
      set: vi.fn().mockReturnValue({ ok: true })
    },
    subscribeEvents: vi.fn().mockReturnValue([])
  }
}

describe('executePluginHostCall mutation auditing', () => {
  it('rejects prototype-sensitive storage keys before any host service call', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: '__proto__', value: 42 },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it('rejects non-JSON storage values before any host service call', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'created', value: new Date() },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it('fails closed before a mutation when the audit intent cannot be recorded', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockRejectedValue(new Error('disk full')) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it('records an intent before the mutation and its outcome afterward', async () => {
    const order: string[] = []
    const storageSet = vi.fn(() => {
      order.push('mutation')
      return { ok: true as const }
    })
    const record = vi.fn(async (entry: { outcome: string }) => {
      order.push(`audit:${entry.outcome}`)
    })

    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices(storageSet),
      audit: { record }
    })

    expect(outcome).toEqual({ ok: true, value: { ok: true } })
    expect(order).toEqual(['audit:attempt', 'mutation', 'audit:ok'])
  })

  it('refuses mutations when no audit writer is configured', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices(storageSet)
    })

    expect(outcome).toMatchObject({ ok: false, code: 'unavailable' })
    expect(storageSet).not.toHaveBeenCalled()
  })
})

function createTerminalHarness(terminalHandles: string[]): {
  delegate: PluginRuntimeDelegate
  services: PluginHostServices
} {
  const delegate: PluginRuntimeDelegate = {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue({
      worktreeId: 'worktree-1',
      path: '/Users/private/repo',
      branch: 'main',
      displayName: 'Repo'
    }),
    listTerminals: vi.fn().mockResolvedValue({
      terminals: terminalHandles.map((handle) => ({ handle, title: null }))
    }),
    sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true })
  }
  return {
    delegate,
    services: bindPluginHostServices({
      delegate,
      pluginsDataDir: join(tmpdir(), 'plugin-host-methods-test'),
      subscribeEvents: vi.fn().mockReturnValue([])
    })
  }
}

async function sendTerminalText(
  services: PluginHostServices,
  terminalId: string
): ReturnType<typeof executePluginHostCall> {
  return executePluginHostCall({
    pluginId: 'orca-samples.demo',
    method: 'terminal.sendText',
    params: { terminalId, text: 'echo hi', enter: true },
    viaPanel: true,
    grantedCapabilities: ['terminal:send'],
    services,
    audit: { record: vi.fn().mockResolvedValue(undefined) }
  })
}

describe('terminal.sendText explicit worktree routing', () => {
  it('performs one bounded list and zero sends when the terminal is outside the worktree', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:other'])

    const outcome = await sendTerminalText(services, 'terminal:ssh:requested')

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(delegate.resolveActiveWorktreeContext).toHaveBeenCalledTimes(1)
    expect(delegate.listTerminals).toHaveBeenCalledTimes(1)
    expect(delegate.listTerminals).toHaveBeenCalledWith(
      'id:worktree-1',
      PLUGIN_WORKSPACE_TERMINAL_LIMIT,
      { includeVisualLayouts: false }
    )
    expect(delegate.sendTerminal).not.toHaveBeenCalled()
  })

  it.each(['terminal:local:one', 'terminal:ssh:opaque-provider-id'])(
    'performs one bounded list and one send for provider-agnostic id %s',
    async (terminalId) => {
      const { delegate, services } = createTerminalHarness([terminalId])

      const outcome = await sendTerminalText(services, terminalId)

      expect(outcome).toEqual({ ok: true, value: { accepted: true } })
      expect(delegate.resolveActiveWorktreeContext).toHaveBeenCalledTimes(1)
      expect(delegate.listTerminals).toHaveBeenCalledTimes(1)
      expect(delegate.listTerminals).toHaveBeenCalledWith(
        'id:worktree-1',
        PLUGIN_WORKSPACE_TERMINAL_LIMIT,
        { includeVisualLayouts: false }
      )
      expect(delegate.sendTerminal).toHaveBeenCalledTimes(1)
      expect(delegate.sendTerminal).toHaveBeenCalledWith(terminalId, {
        text: 'echo hi',
        enter: true
      })
      expect(vi.mocked(delegate.listTerminals).mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked(delegate.sendTerminal).mock.invocationCallOrder[0]!
      )
    }
  )

  it('bounds workspace.readContext and omits the provider path', async () => {
    const handles = Array.from(
      { length: PLUGIN_WORKSPACE_TERMINAL_LIMIT + 10 },
      (_, index) => `terminal:local:${index}`
    )
    const { delegate, services } = createTerminalHarness(handles)

    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.readContext',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['workspace:read'],
      services
    })

    expect(outcome).toMatchObject({
      ok: true,
      value: { branch: 'main', displayName: 'Repo' }
    })
    expect(outcome).not.toHaveProperty('value.path')
    expect(outcome).not.toHaveProperty('value.worktreeId')
    expect(outcome.ok && (outcome.value as { terminals: unknown[] }).terminals).toHaveLength(
      PLUGIN_WORKSPACE_TERMINAL_LIMIT
    )
    expect(delegate.listTerminals).toHaveBeenCalledTimes(1)
  })
})

describe('terminal.sendText under a refusing agent-session lease', () => {
  it('reports who holds the session instead of an accepted-looking result', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:one'])
    vi.mocked(delegate.sendTerminal).mockRejectedValue(
      new AgentSessionPtyWriteRefusedError({
        code: 'agent_session_conflict',
        sessionId: 'session-alpha-1',
        ownerRuntimeKind: 'native',
        handoffStage: null,
        ownerPid: 4242,
        runtimeFence: 7
      })
    )

    const outcome = await sendTerminalText(services, 'terminal:local:one')

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('session-alpha-1')
    expect(outcome.ok ? '' : outcome.error).toContain('native chat')
  })

  it('sends unchanged when no lease refuses, which is every plugin send today', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:one'])

    const outcome = await sendTerminalText(services, 'terminal:local:one')

    expect(outcome).toEqual({ ok: true, value: { accepted: true } })
    expect(delegate.sendTerminal).toHaveBeenCalledTimes(1)
  })
})

describe('workspace file host service binding', () => {
  it('shares router lease truth and delegates runtime workspace reads', async () => {
    pluginEditorWorktreeLeases.revokePlugin('orca-samples.demo')
    const { delegate } = createTerminalHarness([])
    const statPluginWorkspaceFiles = vi.fn().mockResolvedValue([])
    const readPluginWorkspaceDirectory = vi
      .fn()
      .mockResolvedValue({ path: 'src', status: 'ok', entries: [] })
    const readPluginWorkspaceFiles = vi.fn().mockResolvedValue([])
    Object.assign(delegate, {
      statPluginWorkspaceFiles,
      readPluginWorkspaceDirectory,
      readPluginWorkspaceFiles
    })
    const services = bindPluginHostServices({
      delegate,
      pluginsDataDir: join(tmpdir(), 'plugin-host-workspace-binding-test'),
      subscribeEvents: vi.fn().mockReturnValue([])
    })

    expect(services.hasEditorWorktreeLease('orca-samples.demo', 'wt-1')).toBe(false)
    pluginEditorWorktreeLeases.acquire('orca-samples.demo', 'wt-1', 'renderer:1\0doc-1')
    expect(services.hasEditorWorktreeLease('orca-samples.demo', 'wt-1')).toBe(true)

    await services.statPluginWorkspaceFiles('wt-1', ['src/index.ts'])
    await services.readPluginWorkspaceDirectory('wt-1', 'src', 2048)
    await services.readPluginWorkspaceFiles('wt-1', ['src/index.ts'], 1024)
    expect(statPluginWorkspaceFiles).toHaveBeenCalledWith('id:wt-1', ['src/index.ts'])
    expect(readPluginWorkspaceDirectory).toHaveBeenCalledWith('id:wt-1', 'src', 2048)
    expect(readPluginWorkspaceFiles).toHaveBeenCalledWith('id:wt-1', ['src/index.ts'], 1024)

    pluginEditorWorktreeLeases.release('orca-samples.demo', 'wt-1', 'renderer:1\0doc-1')
  })
})

describe('workspace file host methods', () => {
  it('denies workspace source reads from panels and without capability', async () => {
    const services = createServices(vi.fn().mockReturnValue({ ok: true }))
    const panel = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.statFiles',
      params: { worktreeId: 'wt-1', paths: ['src/index.ts'] },
      viaPanel: true,
      grantedCapabilities: ['workspace:readFiles'],
      services
    })
    expect(panel).toMatchObject({ ok: false, code: 'panel_forbidden' })

    const denied = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.statFiles',
      params: { worktreeId: 'wt-1', paths: ['src/index.ts'] },
      viaPanel: false,
      grantedCapabilities: [],
      services
    })
    expect(denied).toMatchObject({ ok: false, code: 'capability_denied' })
  })

  it('rejects a worker read when the editor router owns no lease', async () => {
    const services = Object.assign(createServices(vi.fn().mockReturnValue({ ok: true })), {
      hasEditorWorktreeLease: vi.fn(() => false),
      statPluginWorkspaceFiles: vi.fn()
    })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.statFiles',
      params: { worktreeId: 'wt-1', paths: ['src/index.ts'] },
      viaPanel: false,
      grantedCapabilities: ['workspace:readFiles'],
      services
    })
    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(outcome.ok ? '' : outcome.error).toMatch(/lease/i)
    expect(services.statPluginWorkspaceFiles).not.toHaveBeenCalled()
  })

  it('routes a leased shallow directory read with its entry budget', async () => {
    const readPluginWorkspaceDirectory = vi.fn().mockResolvedValue({
      path: 'src',
      status: 'ok',
      entries: [{ name: 'index.ts', path: 'src/index.ts' }]
    })
    const services = Object.assign(createServices(vi.fn().mockReturnValue({ ok: true })), {
      hasEditorWorktreeLease: vi.fn(() => true),
      readPluginWorkspaceDirectory
    })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.readDirectory',
      params: { worktreeId: 'wt-1', path: 'src' },
      viaPanel: false,
      grantedCapabilities: ['workspace:readFiles'],
      services
    })
    expect(outcome).toEqual({
      ok: true,
      value: { path: 'src', status: 'ok', entries: [{ name: 'index.ts', path: 'src/index.ts' }] }
    })
    expect(readPluginWorkspaceDirectory).toHaveBeenCalledWith(
      'wt-1',
      'src',
      PLUGIN_WORKSPACE_DIRECTORY_ENTRY_LIMIT
    )
  })

  it('routes leased stat and read calls through bounded runtime services', async () => {
    const statPluginWorkspaceFiles = vi
      .fn()
      .mockResolvedValue([
        { path: 'src/index.ts', status: 'ok', type: 'file', byteLength: 3, mtimeMs: 1 }
      ])
    const readPluginWorkspaceFiles = vi
      .fn()
      .mockResolvedValue([
        { path: 'src/index.ts', status: 'ok', content: 'abc', byteLength: 3, mtimeMs: 1 }
      ])
    const services = Object.assign(createServices(vi.fn().mockReturnValue({ ok: true })), {
      hasEditorWorktreeLease: vi.fn(() => true),
      statPluginWorkspaceFiles,
      readPluginWorkspaceFiles
    })

    const statOutcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.statFiles',
      params: { worktreeId: 'wt-1', paths: ['src/index.ts'] },
      viaPanel: false,
      grantedCapabilities: ['workspace:readFiles'],
      services
    })
    expect(statOutcome).toEqual({
      ok: true,
      value: {
        results: [{ path: 'src/index.ts', status: 'ok', type: 'file', byteLength: 3, mtimeMs: 1 }]
      }
    })
    expect(statPluginWorkspaceFiles).toHaveBeenCalledWith('wt-1', ['src/index.ts'])

    const readOutcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.readFiles',
      params: { worktreeId: 'wt-1', paths: ['src/index.ts'] },
      viaPanel: false,
      grantedCapabilities: ['workspace:readFiles'],
      services
    })
    expect(readOutcome).toEqual({
      ok: true,
      value: {
        results: [{ path: 'src/index.ts', status: 'ok', content: 'abc', byteLength: 3, mtimeMs: 1 }]
      }
    })
    expect(readPluginWorkspaceFiles).toHaveBeenCalledWith(
      'wt-1',
      ['src/index.ts'],
      PLUGIN_WORKSPACE_FILE_MAX_BYTES
    )
  })
})
