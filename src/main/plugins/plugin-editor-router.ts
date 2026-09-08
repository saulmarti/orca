import type {
  EditorCompletionRequest,
  EditorCompletionResponse,
  EditorDiagnosticsPublication,
  EditorDocumentChange,
  EditorDocumentOpen
} from '../../shared/plugins/plugin-editor-protocol'
import { PLUGIN_EDITOR_PROVIDER_EXTENSION_POINT } from '../../shared/plugins/plugin-extension-registry'
import { matchingEditorProviderGroups } from './plugin-editor-router-candidates'
import { PluginEditorWorktreeLeases } from './plugin-editor-worktree-leases'
import type {
  BoundProvider,
  DocumentState,
  EditorProviderBinding,
  PendingCompletion,
  PluginEditorRouterOptions
} from './plugin-editor-router-types'

export type {
  EditorProviderBinding,
  PluginEditorRouterOptions,
  RendererEditorDiagnosticsEvent
} from './plugin-editor-router-types'

function documentKey(ownerKey: string, documentId: string): string {
  return `${ownerKey}\u0000${documentId}`
}

function providerKey(pluginKey: string, providerId: string): string {
  return `${pluginKey}/${providerId}`
}

export class PluginEditorRouter {
  private readonly leases: NonNullable<PluginEditorRouterOptions['leases']>
  private readonly documents = new Map<string, DocumentState>()
  private readonly pendingCompletions = new Map<string, PendingCompletion>()

  constructor(private readonly options: PluginEditorRouterOptions) {
    this.leases = options.leases ?? new PluginEditorWorktreeLeases()
  }

  async open(ownerKey: string, document: EditorDocumentOpen): Promise<EditorProviderBinding[]> {
    const key = documentKey(ownerKey, document.documentId)
    const existing = this.documents.get(key)
    if (existing) {
      this.close(ownerKey, document.documentId, existing.version)
    }

    const groups = matchingEditorProviderGroups({
      plugins: this.options.getPlugins(),
      languageId: document.languageId,
      getGrantedCapabilities: this.options.getGrantedCapabilities
    })
    const bindings: BoundProvider[] = []
    for (const [plugin, contributions] of groups) {
      try {
        await this.options.ensurePlugin(plugin)
      } catch {
        continue
      }
      for (const contribution of contributions) {
        const provider = this.options.registry.resolve(
          PLUGIN_EDITOR_PROVIDER_EXTENSION_POINT,
          plugin.pluginKey,
          contribution.id
        )
        if (!provider) {
          continue
        }
        bindings.push({
          key: providerKey(plugin.pluginKey, contribution.id),
          pluginKey: plugin.pluginKey,
          providerId: contribution.id,
          features: contribution.features,
          provider,
          unsubscribeDiagnostics: null
        })
      }
    }
    bindings.sort((left, right) => left.key.localeCompare(right.key))
    const state: DocumentState = {
      ownerKey,
      documentId: document.documentId,
      worktreeId: document.worktreeId,
      version: document.version,
      bindings
    }
    this.documents.set(key, state)
    for (const pluginKey of new Set(bindings.map((binding) => binding.pluginKey))) {
      this.leases.acquire(pluginKey, document.worktreeId, key)
    }

    for (const binding of bindings) {
      if (binding.features.includes('diagnostics')) {
        binding.unsubscribeDiagnostics = binding.provider.onDiagnostics((publication) =>
          this.receiveDiagnostics(key, binding, publication)
        )
      }
      binding.provider.openDocument(document)
    }

    return bindings.map(({ pluginKey, providerId, features }) => ({
      pluginKey,
      providerId,
      features
    }))
  }

  change(ownerKey: string, change: EditorDocumentChange): void {
    const state = this.documents.get(documentKey(ownerKey, change.documentId))
    if (!state) {
      throw new Error(`editor document ${change.documentId} is not open`)
    }
    if (change.version <= state.version) {
      throw new Error(
        `editor document version must increase from ${state.version}; received ${change.version}`
      )
    }
    state.version = change.version
    for (const binding of state.bindings) {
      binding.provider.changeDocument(change)
    }
  }

  async complete(
    ownerKey: string,
    request: EditorCompletionRequest
  ): Promise<EditorCompletionResponse | null> {
    const key = documentKey(ownerKey, request.documentId)
    const state = this.documents.get(key)
    if (
      !state ||
      request.version !== state.version ||
      this.pendingCompletions.has(request.requestId)
    ) {
      return null
    }
    const binding = state.bindings.find((candidate) => candidate.features.includes('completion'))
    if (!binding) {
      return null
    }
    const pending = { documentKey: key, binding }
    this.pendingCompletions.set(request.requestId, pending)
    try {
      const response = await binding.provider.provideCompletions(request)
      if (this.pendingCompletions.get(request.requestId) !== pending) {
        return null
      }
      const current = this.documents.get(key)
      if (
        !current ||
        current.version !== request.version ||
        !current.bindings.includes(binding) ||
        response.requestId !== request.requestId ||
        response.documentId !== request.documentId ||
        response.version !== request.version
      ) {
        return null
      }
      return response
    } catch {
      return null
    } finally {
      if (this.pendingCompletions.get(request.requestId) === pending) {
        this.pendingCompletions.delete(request.requestId)
      }
    }
  }

  cancel(ownerKey: string, requestId: string): void {
    const pending = this.pendingCompletions.get(requestId)
    if (!pending) {
      return
    }
    const state = this.documents.get(pending.documentKey)
    if (!state || state.ownerKey !== ownerKey) {
      return
    }
    pending.binding.provider.cancel(requestId)
    this.pendingCompletions.delete(requestId)
  }

  close(ownerKey: string, documentId: string, finalVersion: number): void {
    const key = documentKey(ownerKey, documentId)
    const state = this.documents.get(key)
    if (!state) {
      return
    }
    this.cancelDocumentRequests(key)
    for (const binding of state.bindings) {
      this.clearDiagnostics(state, binding, finalVersion)
      binding.unsubscribeDiagnostics?.()
      binding.provider.closeDocument({ documentId, finalVersion })
    }
    for (const pluginKey of new Set(state.bindings.map((binding) => binding.pluginKey))) {
      this.leases.release(pluginKey, state.worktreeId, key)
    }
    this.documents.delete(key)
  }

  hasWorktreeLease(pluginKey: string, worktreeId: string): boolean {
    return this.leases.has(pluginKey, worktreeId)
  }

  revokeOwner(ownerKey: string): void {
    for (const state of this.documents.values()) {
      if (state.ownerKey === ownerKey) {
        this.close(ownerKey, state.documentId, state.version)
      }
    }
  }

  revokePlugin(pluginKey: string): void {
    this.leases.revokePlugin(pluginKey)
    for (const [key, state] of this.documents) {
      const revoked = state.bindings.filter((binding) => binding.pluginKey === pluginKey)
      if (revoked.length === 0) {
        continue
      }
      for (const binding of revoked) {
        this.cancelBindingRequests(key, binding)
        this.clearDiagnostics(state, binding, state.version)
        binding.unsubscribeDiagnostics?.()
      }
      state.bindings = state.bindings.filter((binding) => binding.pluginKey !== pluginKey)
    }
  }

  dispose(): void {
    for (const state of this.documents.values()) {
      this.close(state.ownerKey, state.documentId, state.version)
    }
  }

  private receiveDiagnostics(
    key: string,
    binding: BoundProvider,
    publication: EditorDiagnosticsPublication
  ): void {
    const state = this.documents.get(key)
    if (
      !state ||
      !state.bindings.includes(binding) ||
      publication.documentId !== state.documentId ||
      publication.version !== state.version
    ) {
      return
    }
    this.options.onDiagnostics({
      ownerKey: state.ownerKey,
      pluginKey: binding.pluginKey,
      providerId: binding.providerId,
      features: binding.features,
      publication
    })
  }

  private clearDiagnostics(state: DocumentState, binding: BoundProvider, version: number): void {
    if (!binding.features.includes('diagnostics')) {
      return
    }
    this.options.onDiagnostics({
      ownerKey: state.ownerKey,
      pluginKey: binding.pluginKey,
      providerId: binding.providerId,
      features: binding.features,
      publication: { documentId: state.documentId, version, diagnostics: [] }
    })
  }

  private cancelDocumentRequests(key: string): void {
    for (const [requestId, pending] of this.pendingCompletions) {
      if (pending.documentKey === key) {
        pending.binding.provider.cancel(requestId)
        this.pendingCompletions.delete(requestId)
      }
    }
  }

  private cancelBindingRequests(key: string, binding: BoundProvider): void {
    for (const [requestId, pending] of this.pendingCompletions) {
      if (pending.documentKey === key && pending.binding === binding) {
        binding.provider.cancel(requestId)
        this.pendingCompletions.delete(requestId)
      }
    }
  }
}
