import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginService } from './plugin-service'
import type { PluginWorkerFactory } from './plugin-worker-manager'

const roots: string[] = []
const services: PluginService[] = []

function worker(): PluginWorkerHandle {
  return {
    commands: [],
    editorProviders: ['typescript'],
    invokeCommand: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    openEditorDocument: vi.fn(),
    changeEditorDocument: vi.fn(),
    closeEditorDocument: vi.fn(),
    requestEditorCompletion: vi.fn(async (request) => ({
      requestId: request.requestId,
      documentId: request.documentId,
      version: request.version,
      completion: { isIncomplete: false, items: [] }
    })),
    cancelEditorRequest: vi.fn(),
    onEditorDiagnostics: vi.fn(() => vi.fn()),
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginService editor router', () => {
  it('keeps editor workers lazy until a matching document opens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-editor-service-'))
    roots.push(root)
    const manifest = pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'orca-samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'worker.mjs',
      contributes: {
        panels: [],
        commands: [],
        events: [],
        editorProviders: [
          {
            id: 'typescript',
            languages: ['typescript'],
            features: ['completion', 'diagnostics']
          }
        ]
      },
      capabilities: [{ kind: 'editor:languageService' }]
    })
    await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(root, 'worker.mjs'), 'export default function activate() {}')
    const factory = vi.fn<PluginWorkerFactory>().mockResolvedValue(worker())
    const service = new PluginService({
      userDataPath: root,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [],
      getPluginConsents: () => ({
        'orca-samples.demo': fingerprintPluginConsent(manifest)
      }),
      getDevPluginPaths: () => [root],
      workerFactory: factory
    })
    services.push(service)

    await service.initialize()
    expect(factory).not.toHaveBeenCalled()

    const bindings = await service.editor.open('renderer:1', {
      documentId: 'doc-1',
      worktreeId: 'worktree-1',
      filePath: 'src/index.ts',
      languageId: 'typescript',
      version: 1,
      text: 'const value = 1'
    })

    expect(factory).toHaveBeenCalledOnce()
    expect(bindings).toEqual([
      {
        pluginKey: 'orca-samples.demo',
        providerId: 'typescript',
        features: ['completion', 'diagnostics']
      }
    ])
  })
})
