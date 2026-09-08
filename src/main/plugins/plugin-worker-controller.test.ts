import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_EDITOR_PROVIDER_EXTENSION_POINT,
  createPluginExtensionRegistry,
  type PluginExtensionRegistry
} from '../../shared/plugins/plugin-extension-registry'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { PluginContentVerifier } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginWorkerController } from './plugin-worker-controller'
import type { PluginWorkerFactory } from './plugin-worker-manager'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function plugin(): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-worker-controller-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'main.mjs'), 'export default function activate() {}')
  return {
    pluginKey: 'orca-samples.demo',
    rootDir,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'orca-samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'main.mjs',
      contributes: {
        panels: [],
        commands: [{ id: 'run', title: 'Run' }],
        events: []
      },
      capabilities: []
    }),
    consentFingerprint: 'sha256-current',
    contentHash: null,
    isDev: true
  }
}

function worker(
  commands: string[],
  editorProviders: string[] = []
): PluginWorkerHandle & { dispose: ReturnType<typeof vi.fn> } {
  return {
    commands,
    editorProviders,
    invokeCommand: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    openEditorDocument: vi.fn(),
    changeEditorDocument: vi.fn(),
    closeEditorDocument: vi.fn(),
    requestEditorCompletion: vi.fn(async () => ({
      requestId: 'req-1',
      documentId: 'doc-1',
      version: 1,
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

function controller(options: {
  factory: PluginWorkerFactory
  verify: () => Promise<void>
  isApproved: () => boolean
  registry?: PluginExtensionRegistry
  capabilities?: () => readonly 'editor:languageService'[]
}): PluginWorkerController {
  return new PluginWorkerController({
    entryPath: '/host-entry.js',
    workerFactory: options.factory,
    registry: options.registry ?? createPluginExtensionRegistry(),
    contentVerifier: { verify: options.verify } as unknown as PluginContentVerifier,
    capabilities: () => (options.isApproved() ? (options.capabilities?.() ?? []) : null),
    isCurrentApproved: () => options.isApproved(),
    invokeCommand: vi.fn(async () => null),
    executeHostCall: vi.fn(async () => ({ ok: true as const, value: null })),
    log: vi.fn(),
    onStateChanged: vi.fn(),
    onWorkerGone: vi.fn()
  })
}

describe('PluginWorkerController activation authority', () => {
  it('does not start code after approval is revoked during integrity verification', async () => {
    const subjectPlugin = await plugin()
    let approved = true
    let finishVerification!: () => void
    const verification = new Promise<void>((resolve) => {
      finishVerification = resolve
    })
    const factory = vi.fn<PluginWorkerFactory>()
    const subject = controller({ factory, verify: () => verification, isApproved: () => approved })

    const activation = subject.ensure(subjectPlugin)
    approved = false
    finishVerification()

    await expect(activation).rejects.toThrow('no longer approved')
    expect(factory).not.toHaveBeenCalled()
    await subject.dispose()
  })

  it('disposes a worker whose approval changes while the process starts', async () => {
    const subjectPlugin = await plugin()
    let approved = true
    let finishStart!: (handle: PluginWorkerHandle) => void
    const factory = vi.fn<PluginWorkerFactory>(
      () => new Promise<PluginWorkerHandle>((resolve) => (finishStart = resolve))
    )
    const subject = controller({
      factory,
      verify: async () => undefined,
      isApproved: () => approved
    })
    const startedWorker = worker(['run'])

    const activation = subject.ensure(subjectPlugin)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
    approved = false
    finishStart(startedWorker)

    await expect(activation).rejects.toThrow('disabled during activation')
    expect(startedWorker.dispose).toHaveBeenCalledOnce()
    await subject.dispose()
  })

  it('rejects and stops workers that register undeclared commands', async () => {
    const subjectPlugin = await plugin()
    const startedWorker = worker(['run', 'undeclared'])
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(startedWorker),
      verify: async () => undefined,
      isApproved: () => true
    })

    await expect(subject.ensure(subjectPlugin)).rejects.toThrow(
      'registered undeclared command undeclared'
    )
    expect(startedWorker.dispose).toHaveBeenCalledOnce()
    await subject.dispose()
  })

  it('rejects workers that register declarative action aliases', async () => {
    const base = await plugin()
    const subjectPlugin: ValidDiscoveredPlugin = {
      ...base,
      manifest: pluginManifestSchema.parse({
        ...base.manifest,
        contributes: {
          ...base.manifest.contributes,
          commands: [{ id: 'tasks', title: 'Tasks', action: 'view.tasks' }]
        }
      })
    }
    const startedWorker = worker(['tasks'])
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(startedWorker),
      verify: async () => undefined,
      isApproved: () => true
    })

    await expect(subject.ensure(subjectPlugin)).rejects.toThrow(
      'registered undeclared command tasks'
    )
    expect(startedWorker.dispose).toHaveBeenCalledOnce()
    await subject.dispose()
  })
})

describe('PluginWorkerController editor providers', () => {
  async function editorPlugin(): Promise<ValidDiscoveredPlugin> {
    const base = await plugin()
    return {
      ...base,
      manifest: pluginManifestSchema.parse({
        ...base.manifest,
        contributes: {
          ...base.manifest.contributes,
          editorProviders: [
            {
              id: 'typescript',
              languages: ['typescript', 'javascript'],
              features: ['completion', 'diagnostics']
            }
          ]
        },
        capabilities: [{ kind: 'editor:languageService' }]
      })
    }
  }

  it('rejects and stops workers that register undeclared editor providers', async () => {
    const subjectPlugin = await plugin()
    const startedWorker = worker(['run'], ['not-declared'])
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(startedWorker),
      verify: async () => undefined,
      isApproved: () => true
    })

    await expect(subject.ensure(subjectPlugin)).rejects.toThrow(
      'registered undeclared editor provider not-declared'
    )
    expect(startedWorker.dispose).toHaveBeenCalledOnce()
    await subject.dispose()
  })

  it('registers a worker-backed editor provider proxy', async () => {
    const subjectPlugin = await editorPlugin()
    const startedWorker = worker(['run'], ['typescript'])
    const registry = createPluginExtensionRegistry()
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(startedWorker),
      verify: async () => undefined,
      isApproved: () => true,
      registry,
      capabilities: () => ['editor:languageService']
    })

    await subject.ensure(subjectPlugin)
    const provider = registry.resolve(
      PLUGIN_EDITOR_PROVIDER_EXTENSION_POINT,
      subjectPlugin.pluginKey,
      'typescript'
    )

    expect(provider).toMatchObject({
      providerId: 'typescript',
      languages: ['typescript', 'javascript'],
      features: ['completion', 'diagnostics']
    })
    provider?.openDocument({
      documentId: 'doc-1',
      worktreeId: 'worktree-1',
      filePath: 'src/index.ts',
      languageId: 'typescript',
      version: 1,
      text: ''
    })
    expect(startedWorker.openEditorDocument).toHaveBeenCalledWith(
      'typescript',
      expect.objectContaining({ documentId: 'doc-1' })
    )
    await subject.dispose()
  })
})
