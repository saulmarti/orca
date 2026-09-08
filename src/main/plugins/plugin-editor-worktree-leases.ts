function leaseKey(pluginKey: string, worktreeId: string): string {
  return `${pluginKey}\u0000${worktreeId}`
}

export class PluginEditorWorktreeLeases {
  private readonly documents = new Map<string, Set<string>>()

  acquire(pluginKey: string, worktreeId: string, documentKey: string): void {
    const key = leaseKey(pluginKey, worktreeId)
    const documents = this.documents.get(key) ?? new Set<string>()
    documents.add(documentKey)
    this.documents.set(key, documents)
  }

  release(pluginKey: string, worktreeId: string, documentKey: string): void {
    const key = leaseKey(pluginKey, worktreeId)
    const documents = this.documents.get(key)
    if (!documents) {
      return
    }
    documents.delete(documentKey)
    if (documents.size === 0) {
      this.documents.delete(key)
    }
  }

  revokePlugin(pluginKey: string): void {
    const prefix = `${pluginKey}\u0000`
    for (const key of this.documents.keys()) {
      if (key.startsWith(prefix)) {
        this.documents.delete(key)
      }
    }
  }

  has(pluginKey: string, worktreeId: string): boolean {
    return this.documents.has(leaseKey(pluginKey, worktreeId))
  }
}

export const pluginEditorWorktreeLeases = new PluginEditorWorktreeLeases()
