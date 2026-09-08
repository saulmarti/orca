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
