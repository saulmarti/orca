import { describe, expect, it } from 'vitest'
import { DocumentStore } from './document-store'
import { adaptDiagnostics } from './diagnostic-adapter'
import { TypeScriptProject } from './typescript-project'
import { WorkspaceFileCache } from './workspace-file-cache'

function createProject(text: string) {
  const cache = new WorkspaceFileCache()
  const documents = new DocumentStore()
  const key = 'wt-1\u0000inferred:'
  documents.open({
    documentId: 'doc-1',
    worktreeId: 'wt-1',
    filePath: '/repo/src/example.ts',
    relativePath: 'src/example.ts',
    languageId: 'typescript',
    version: 1,
    text
  })
  const project = new TypeScriptProject({
    key,
    worktreeId: 'wt-1',
    rootRelativePath: '',
    documents,
    cache,
    rootFiles: ['src/example.ts']
  })
  return { documents, project }
}

describe('diagnostic adapter', () => {
  it('maps TypeScript syntax diagnostics to Orca ranges, source, and code', () => {
    const { project } = createProject('const value =')
    const diagnostics = adaptDiagnostics(
      project,
      'src/example.ts',
      project.getSyntacticDiagnostics('src/example.ts')
    )

    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics[0]).toMatchObject({ severity: 'error', source: 'typescript' })
    expect(diagnostics[0]?.code).toMatch(/^\d+$/)
  })

  it('maps semantic diagnostics and clears after the source is corrected', () => {
    const { documents, project } = createProject("const value: number = 'wrong'")
    const before = adaptDiagnostics(
      project,
      'src/example.ts',
      project.getSemanticDiagnostics('src/example.ts')
    )
    expect(before.some((diagnostic) => diagnostic.code === '2322')).toBe(true)

    documents.change({
      documentId: 'doc-1',
      version: 2,
      changes: [
        {
          range: { start: { line: 0, character: 22 }, end: { line: 0, character: 29 } },
          rangeLength: 7,
          text: '1'
        }
      ]
    })
    project.noteDocumentChange()
    const after = adaptDiagnostics(
      project,
      'src/example.ts',
      project.getSemanticDiagnostics('src/example.ts')
    )
    expect(after).toEqual([])
  })
})
