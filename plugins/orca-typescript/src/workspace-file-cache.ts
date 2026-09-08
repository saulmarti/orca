import type { DocumentStore } from './document-store'

export const DEFAULT_PROJECT_TEXT_BUDGET = 32 * 1024 * 1024
export const DEFAULT_WORKER_TEXT_BUDGET = 128 * 1024 * 1024

export type WorkspaceFileInput = { text: string; byteLength: number; mtimeMs: number }
type FileRecord = WorkspaceFileInput & {
  status: 'file'
  scriptVersion: number
  projectKeys: Set<string>
  lastUsed: number
}
type MissingRecord = {
  status: 'missing'
  projectKeys: Set<string>
  lastUsed: number
}
type DiskRecord = FileRecord | MissingRecord
export type CachedDiskRecord =
  | (Omit<FileRecord, 'projectKeys' | 'lastUsed'> & { projectKeys?: never })
  | { status: 'missing' }

function pathKey(worktreeId: string, relativePath: string): string {
  return `${worktreeId}\u0000${relativePath}`
}

export class WorkspaceFileCache {
  private readonly records = new Map<string, DiskRecord>()
  private clock = 0
  private readonly projectByteBudget: number
  private readonly workerByteBudget: number

  constructor(options: { projectByteBudget?: number; workerByteBudget?: number } = {}) {
    this.projectByteBudget = options.projectByteBudget ?? DEFAULT_PROJECT_TEXT_BUDGET
    this.workerByteBudget = options.workerByteBudget ?? DEFAULT_WORKER_TEXT_BUDGET
  }

  setMissing(projectKey: string, worktreeId: string, relativePath: string): void {
    const key = pathKey(worktreeId, relativePath)
    const current = this.records.get(key)
    const projectKeys = current?.projectKeys ?? new Set<string>()
    projectKeys.add(projectKey)
    this.records.set(key, { status: 'missing', projectKeys, lastUsed: ++this.clock })
  }

  setFile(
    projectKey: string,
    worktreeId: string,
    relativePath: string,
    input: WorkspaceFileInput
  ): boolean {
    const key = pathKey(worktreeId, relativePath)
    const current = this.records.get(key)
    const projectKeys = current?.projectKeys ?? new Set<string>()
    projectKeys.add(projectKey)
    const changed =
      current?.status !== 'file' || current.text !== input.text || current.mtimeMs !== input.mtimeMs
    const scriptVersion = current?.status === 'file' ? current.scriptVersion + Number(changed) : 1
    this.records.set(key, {
      status: 'file',
      ...input,
      scriptVersion,
      projectKeys,
      lastUsed: ++this.clock
    })
    this.enforceProjectBudget(projectKey)
    this.enforceWorkerBudget()
    return changed
  }

  getDisk(worktreeId: string, relativePath: string): CachedDiskRecord | undefined {
    const record = this.records.get(pathKey(worktreeId, relativePath))
    if (!record) {
      return undefined
    }
    record.lastUsed = ++this.clock
    if (record.status === 'missing') {
      return { status: 'missing' }
    }
    return {
      status: 'file',
      text: record.text,
      byteLength: record.byteLength,
      mtimeMs: record.mtimeMs,
      scriptVersion: record.scriptVersion
    }
  }

  hasFile(worktreeId: string, relativePath: string): boolean {
    return this.records.get(pathKey(worktreeId, relativePath))?.status === 'file'
  }

  resolveText(
    documents: DocumentStore,
    worktreeId: string,
    relativePath: string
  ): string | undefined {
    const overlay = documents.getOpenByPath(worktreeId, relativePath)
    if (overlay) {
      return overlay.text
    }
    const disk = this.getDisk(worktreeId, relativePath)
    return disk?.status === 'file' ? disk.text : undefined
  }

  projectTextBytes(projectKey: string): number {
    let total = 0
    for (const record of this.records.values()) {
      if (record.status === 'file' && record.projectKeys.has(projectKey)) {
        total += record.byteLength
      }
    }
    return total
  }

  totalTextBytes(): number {
    let total = 0
    for (const record of this.records.values()) {
      if (record.status === 'file') {
        total += record.byteLength
      }
    }
    return total
  }
  private enforceProjectBudget(projectKey: string): void {
    while (this.projectTextBytes(projectKey) > this.projectByteBudget) {
      const candidate = this.oldestFile((record) => record.projectKeys.has(projectKey))
      if (!candidate) {
        return
      }
      candidate.record.projectKeys.delete(projectKey)
      if (candidate.record.projectKeys.size === 0) {
        this.records.delete(candidate.key)
      }
    }
  }

  private enforceWorkerBudget(): void {
    while (this.totalTextBytes() > this.workerByteBudget) {
      const candidate = this.oldestFile(() => true)
      if (!candidate) {
        return
      }
      this.records.delete(candidate.key)
    }
  }

  private oldestFile(
    predicate: (record: FileRecord) => boolean
  ): { key: string; record: FileRecord } | undefined {
    let oldest: { key: string; record: FileRecord } | undefined
    for (const [key, record] of this.records) {
      if (record.status !== 'file' || !predicate(record)) {
        continue
      }
      if (!oldest || record.lastUsed < oldest.record.lastUsed) {
        oldest = { key, record }
      }
    }
    return oldest
  }
}
