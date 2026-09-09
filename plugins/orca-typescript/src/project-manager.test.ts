import { describe, expect, it } from 'vitest'
import { DocumentStore } from './document-store'
import { ProjectManager } from './project-manager'
import { WorkspaceFileCache } from './workspace-file-cache'

const resolution = {
  kind: 'inferred' as const,
  rootRelativePath: '',
  key: 'wt-1\u0000inferred:'
}

describe('ProjectManager', () => {
  it('reuses one LanguageService across ordinary edits and advances project version', () => {
    const documents = new DocumentStore()
    const cache = new WorkspaceFileCache()
    documents.open({
      documentId: 'doc-1',
      worktreeId: 'wt-1',
      filePath: '/repo/src/example.ts',
      relativePath: 'src/example.ts',
      languageId: 'typescript',
      version: 1,
      text: 'const value = 1'
    })
    const manager = new ProjectManager({ documents, cache })
    const project = manager.getOrCreate({ resolution, rootFiles: ['src/example.ts'] })
    const service = project.languageService
    const version = project.getProjectVersion()

    documents.change({
      documentId: 'doc-1',
      version: 2,
      changes: [
        {
          range: { start: { line: 0, character: 14 }, end: { line: 0, character: 15 } },
          rangeLength: 1,
          text: '2'
        }
      ]
    })
    manager.noteDocumentChange(resolution.key)

    const again = manager.getOrCreate({ resolution, rootFiles: ['src/example.ts'] })
    expect(again).toBe(project)
    expect(again.languageService).toBe(service)
    expect(again.getProjectVersion()).toBe(version + 1)
  })

  it('recreates only a structurally invalidated project', () => {
    const documents = new DocumentStore()
    const cache = new WorkspaceFileCache()
    const manager = new ProjectManager({ documents, cache })
    const first = manager.getOrCreate({ resolution, rootFiles: ['src/example.ts'] })

    manager.invalidate(resolution.key)
    const second = manager.getOrCreate({ resolution, rootFiles: ['src/example.ts'] })

    expect(second).not.toBe(first)
    expect(second.languageService).not.toBe(first.languageService)
  })
})

describe('ProjectManager dependency invalidation', () => {
  it('refreshes a closed dependency without recreating the LanguageService', () => {
    const documents = new DocumentStore()
    const cache = new WorkspaceFileCache()
    const manager = new ProjectManager({ documents, cache })
    cache.setFile(resolution.key, 'wt-1', 'src/user.ts', {
      text: 'export interface User { name: string }',
      byteLength: 38,
      mtimeMs: 1
    })
    cache.setFile(resolution.key, 'wt-1', 'src/example.ts', {
      text: "import type { User } from './user'\nconst user: User = { name: 'x' }",
      byteLength: 70,
      mtimeMs: 1
    })
    const project = manager.getOrCreate({
      resolution,
      rootFiles: ['src/user.ts', 'src/example.ts']
    })
    const service = project.languageService
    expect(project.getSemanticDiagnostics('src/example.ts')).toEqual([])

    const changed = manager.refreshDependency(resolution.key, 'src/user.ts', {
      text: 'export interface User { name: string; email: string }',
      byteLength: 53,
      mtimeMs: 2
    })

    expect(changed).toBe(true)
    expect(project.languageService).toBe(service)
    expect(project.getSemanticDiagnostics('src/example.ts').length).toBeGreaterThan(0)
  })

  it('invalidates only the configured project whose boundary changed', () => {
    const documents = new DocumentStore()
    const cache = new WorkspaceFileCache()
    const manager = new ProjectManager({ documents, cache })
    const otherResolution = {
      kind: 'configured' as const,
      configRelativePath: 'packages/b/tsconfig.json',
      key: 'wt-1\u0000config:packages/b/tsconfig.json'
    }
    const first = manager.getOrCreate({ resolution, rootFiles: ['src/example.ts'] })
    const other = manager.getOrCreate({
      resolution: otherResolution,
      rootFiles: ['packages/b/index.ts']
    })

    manager.invalidate(resolution.key)

    expect(manager.getOrCreate({ resolution, rootFiles: ['src/example.ts'] })).not.toBe(first)
    expect(
      manager.getOrCreate({ resolution: otherResolution, rootFiles: ['packages/b/index.ts'] })
    ).toBe(other)
  })
})

describe('ProjectManager bundled standard libraries', () => {
  it('forwards the configured standard library directory to new projects', () => {
    const documents = new DocumentStore()
    const cache = new WorkspaceFileCache()
    const manager = new ProjectManager({
      documents,
      cache,
      standardLibDirectory: '/artifact/lib'
    } as never)
    const project = manager.getOrCreate({ resolution, rootFiles: ['src/example.ts'] })

    expect(Reflect.get(project, 'standardLibDirectory')).toBe('/artifact/lib')
  })
})
