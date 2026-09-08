import { describe, expect, it, vi } from 'vitest'
import {
  createPluginExtensionRegistry,
  PLUGIN_EDITOR_PROVIDER_EXTENSION_POINT
} from '../../shared/plugins/plugin-extension-registry'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { PluginEditorProviderContribution } from '../../shared/plugins/plugin-editor-contributions'
import type {
  EditorCompletionResponse,
  EditorDiagnosticsPublication
} from '../../shared/plugins/plugin-editor-protocol'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginEditorRouter, type RendererEditorDiagnosticsEvent } from './plugin-editor-router'

function plugin(
  pluginKey: string,
  editorProviders: PluginEditorProviderContribution[]
): ValidDiscoveredPlugin {
  const [publisher = 'tests', id = 'provider'] = pluginKey.split('.')
  return {
    pluginKey,
    rootDir: `/plugins/${pluginKey}`,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id,
      publisher,
      name: pluginKey,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'worker.mjs',
      contributes: { panels: [], commands: [], events: [], editorProviders },
      capabilities: [{ kind: 'editor:languageService' }]
    }),
    consentFingerprint: 'sha256-test',
    contentHash: null,
    isDev: true
  }
}

function contribution(
  id: string,
  features: ('completion' | 'diagnostics')[] = ['completion', 'diagnostics'],
  languages = ['typescript']
): PluginEditorProviderContribution {
  return { id, languages, features }
}

type TestProvider = {
  openDocument: ReturnType<typeof vi.fn>
  changeDocument: ReturnType<typeof vi.fn>
  closeDocument: ReturnType<typeof vi.fn>
  provideCompletions: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  emit(publication: EditorDiagnosticsPublication): void
}

function provider(
  providerId: string,
  languages = ['typescript'],
  features: ('completion' | 'diagnostics')[] = ['completion', 'diagnostics']
): TestProvider & {
  providerId: string
  languages: string[]
  features: ('completion' | 'diagnostics')[]
  onDiagnostics: (callback: (publication: EditorDiagnosticsPublication) => void) => () => void
} {
  const listeners = new Set<(publication: EditorDiagnosticsPublication) => void>()
  return {
    providerId,
    languages,
    features,
    openDocument: vi.fn(),
    changeDocument: vi.fn(),
    closeDocument: vi.fn(),
    provideCompletions: vi.fn(async (request) => ({
      requestId: request.requestId,
      documentId: request.documentId,
      version: request.version,
      completion: { isIncomplete: false, items: [{ label: providerId }] }
    })),
    cancel: vi.fn(),
    onDiagnostics(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    emit(publication) {
      for (const listener of listeners) {
        listener(publication)
      }
    }
  }
}

function document(version = 1) {
  return {
    documentId: 'doc-1',
    worktreeId: 'worktree-1',
    filePath: 'src/index.ts',
    relativePath: 'src/index.ts',
    languageId: 'typescript',
    version,
    text: 'const value = 1'
  }
}

function request(version = 1) {
  return {
    requestId: 'req-1',
    documentId: 'doc-1',
    version,
    position: { line: 0, character: 5 },
    context: { triggerKind: 'invoked' as const }
  }
}

function harness(
  entries: { plugin: ValidDiscoveredPlugin; providers: ReturnType<typeof provider>[] }[]
) {
  const registry = createPluginExtensionRegistry()
  const diagnostics: RendererEditorDiagnosticsEvent[] = []
  const leases = {
    acquire: vi.fn(),
    release: vi.fn(),
    revokePlugin: vi.fn(),
    has: vi.fn(() => false)
  }
  const activated = new Set<string>()
  const ensurePlugin = vi.fn(async (subject: ValidDiscoveredPlugin) => {
    if (activated.has(subject.pluginKey)) {
      return
    }
    activated.add(subject.pluginKey)
    const entry = entries.find((candidate) => candidate.plugin === subject)
    for (const item of entry?.providers ?? []) {
      registry.register(
        PLUGIN_EDITOR_PROVIDER_EXTENSION_POINT,
        subject.pluginKey,
        item as never,
        item.providerId
      )
    }
  })
  const router = new PluginEditorRouter({
    getPlugins: () => entries.map((entry) => entry.plugin),
    getGrantedCapabilities: () => ['editor:languageService'],
    ensurePlugin,
    registry,
    onDiagnostics: (event) => diagnostics.push(event),
    leases
  })
  return { router, ensurePlugin, diagnostics, leases }
}

describe('PluginEditorRouter', () => {
  it('lazily starts only matching language providers and opens all matching bindings', async () => {
    const ts = provider('ts')
    const python = provider('py', ['python'])
    const first = plugin('alpha.tools', [contribution('ts')])
    const second = plugin('beta.tools', [contribution('py', ['diagnostics'], ['python'])])
    const { router, ensurePlugin } = harness([
      { plugin: first, providers: [ts] },
      { plugin: second, providers: [python] }
    ])

    const bindings = await router.open('renderer:1', document())

    expect(ensurePlugin).toHaveBeenCalledTimes(1)
    expect(ensurePlugin).toHaveBeenCalledWith(first)
    expect(ts.openDocument).toHaveBeenCalledWith(document())
    expect(python.openDocument).not.toHaveBeenCalled()
    expect(bindings).toEqual([
      { pluginKey: 'alpha.tools', providerId: 'ts', features: ['completion', 'diagnostics'] }
    ])
  })

  it('acquires, releases, and revokes router-derived editor worktree leases', async () => {
    const subject = provider('ts')
    const { router, leases } = harness([
      { plugin: plugin('alpha.tools', [contribution('ts')]), providers: [subject] }
    ])

    await router.open('renderer:1', document())
    expect(leases.acquire).toHaveBeenCalledWith(
      'alpha.tools',
      'worktree-1',
      'renderer:1\u0000doc-1'
    )

    router.close('renderer:1', 'doc-1', 1)
    expect(leases.release).toHaveBeenCalledWith(
      'alpha.tools',
      'worktree-1',
      'renderer:1\u0000doc-1'
    )

    await router.open('renderer:1', document())
    router.revokePlugin('alpha.tools')
    expect(leases.revokePlugin).toHaveBeenCalledWith('alpha.tools')
  })

  it('uses lexical plugin/provider order for one completion provider', async () => {
    const zed = provider('z')
    const alpha = provider('a')
    const { router } = harness([
      { plugin: plugin('zeta.tools', [contribution('z')]), providers: [zed] },
      { plugin: plugin('alpha.tools', [contribution('a')]), providers: [alpha] }
    ])
    await router.open('renderer:1', document())

    const result = await router.complete('renderer:1', request())

    expect(result?.completion.items[0]?.label).toBe('a')
    expect(alpha.provideCompletions).toHaveBeenCalledOnce()
    expect(zed.provideCompletions).not.toHaveBeenCalled()
  })

  it('enforces monotonic document versions and drops stale completion results', async () => {
    let resolveCompletion!: (response: EditorCompletionResponse) => void
    const slow = provider('ts')
    slow.provideCompletions = vi.fn(
      () =>
        new Promise<EditorCompletionResponse>((resolve) => {
          resolveCompletion = resolve
        })
    )
    const { router } = harness([
      { plugin: plugin('alpha.tools', [contribution('ts')]), providers: [slow] }
    ])
    await router.open('renderer:1', document())
    const completion = router.complete('renderer:1', request())

    router.change('renderer:1', {
      documentId: 'doc-1',
      version: 2,
      changes: [
        {
          range: { start: { line: 0, character: 15 }, end: { line: 0, character: 16 } },
          rangeLength: 1,
          text: '2'
        }
      ]
    })
    expect(() =>
      router.change('renderer:1', {
        documentId: 'doc-1',
        version: 2,
        changes: [
          {
            range: { start: { line: 0, character: 15 }, end: { line: 0, character: 16 } },
            rangeLength: 1,
            text: '3'
          }
        ]
      })
    ).toThrow('must increase')
    resolveCompletion({
      requestId: 'req-1',
      documentId: 'doc-1',
      version: 1,
      completion: { isIncomplete: false, items: [{ label: 'stale' }] }
    })

    await expect(completion).resolves.toBeNull()
    expect(slow.changeDocument).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }))
  })

  it('fans current diagnostics out and drops stale publications', async () => {
    const diagnosticsProvider = provider('ts', ['typescript'], ['diagnostics'])
    const { router, diagnostics } = harness([
      {
        plugin: plugin('alpha.tools', [contribution('ts', ['diagnostics'])]),
        providers: [diagnosticsProvider]
      }
    ])
    await router.open('renderer:1', document())
    router.change('renderer:1', {
      documentId: 'doc-1',
      version: 2,
      changes: [
        {
          range: { start: { line: 0, character: 15 }, end: { line: 0, character: 16 } },
          rangeLength: 1,
          text: '2'
        }
      ]
    })

    diagnosticsProvider.emit({ documentId: 'doc-1', version: 1, diagnostics: [] })
    diagnosticsProvider.emit({ documentId: 'doc-1', version: 2, diagnostics: [] })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      ownerKey: 'renderer:1',
      pluginKey: 'alpha.tools',
      providerId: 'ts',
      publication: { version: 2 }
    })
  })

  it('cancels pending requests and clears provider state on close/revocation', async () => {
    const subject = provider('ts')
    subject.provideCompletions = vi.fn(() => new Promise<EditorCompletionResponse>(() => undefined))
    const { router, diagnostics } = harness([
      { plugin: plugin('alpha.tools', [contribution('ts')]), providers: [subject] }
    ])
    await router.open('renderer:1', document())
    void router.complete('renderer:1', request())

    router.close('renderer:1', 'doc-1', 1)

    expect(subject.cancel).toHaveBeenCalledWith('req-1')
    expect(subject.closeDocument).toHaveBeenCalledWith({ documentId: 'doc-1', finalVersion: 1 })
    expect(diagnostics.at(-1)).toMatchObject({ providerId: 'ts', publication: { diagnostics: [] } })

    await router.open('renderer:1', document())
    router.revokePlugin('alpha.tools')
    expect(await router.complete('renderer:1', request())).toBeNull()
    router.revokeOwner('renderer:1')
  })

  it('does not expose source text when language-service capability is denied', async () => {
    const subjectPlugin = plugin('alpha.tools', [contribution('ts')])
    const subject = provider('ts')
    const registry = createPluginExtensionRegistry()
    const ensurePlugin = vi.fn()
    const router = new PluginEditorRouter({
      getPlugins: () => [subjectPlugin],
      getGrantedCapabilities: () => null,
      ensurePlugin,
      registry,
      onDiagnostics: vi.fn(),
      leases: {
        acquire: vi.fn(),
        release: vi.fn(),
        revokePlugin: vi.fn(),
        has: vi.fn(() => false)
      }
    })

    expect(await router.open('renderer:1', document())).toEqual([])
    expect(ensurePlugin).not.toHaveBeenCalled()
    expect(subject.openDocument).not.toHaveBeenCalled()
  })
})
