import { describe, expect, it } from 'vitest'
import * as ts from '@typescript/typescript6'
import { DocumentStore } from './document-store'
import { adaptCompletionEntry, provideCompletions } from './completion-adapter'
import { TypeScriptProject } from './typescript-project'
import { WorkspaceFileCache } from './workspace-file-cache'

function createProject(source: string, extra: Record<string, string> = {}) {
  const cache = new WorkspaceFileCache()
  const documents = new DocumentStore()
  const key = 'wt-1\u0000inferred:'
  const files = { 'src/example.ts': source, ...extra }
  for (const [path, text] of Object.entries(files)) {
    cache.setFile(key, 'wt-1', path, { text, byteLength: Buffer.byteLength(text), mtimeMs: 1 })
  }
  return new TypeScriptProject({
    key,
    worktreeId: 'wt-1',
    rootRelativePath: '',
    documents,
    cache,
    rootFiles: Object.keys(files)
  })
}

describe('completion adapter', () => {
  it('maps property completions and replacement spans to Orca text edits', () => {
    const source = "const user = { name: 'Saul' }\nuser.na"
    const project = createProject(source)
    const completion = provideCompletions(project, 'src/example.ts', { line: 1, character: 7 })
    const item = completion.items.find((candidate) => candidate.label === 'name')

    expect(item).toMatchObject({ kind: 'property', label: 'name' })
    expect(item?.textEdit).toBeUndefined()
  })

  it('maps a TypeScript replacementSpan when TypeScript provides one', () => {
    const source = "const user = { name: 'Saul' }\nuser.na"
    const project = createProject(source)
    const item = adaptCompletionEntry(project, 'src/example.ts', {
      name: 'name',
      kind: ts.ScriptElementKind.memberVariableElement,
      kindModifiers: '',
      sortText: '11',
      replacementSpan: { start: source.length - 2, length: 2 }
    })
    expect(item.textEdit).toEqual({
      range: { start: { line: 1, character: 5 }, end: { line: 1, character: 7 } },
      newText: 'name'
    })
  })

  it('keeps auto-import candidates visible without inventing additional edits', () => {
    const project = createProject('hel', { 'src/util.ts': 'export const helperValue = 1' })
    const completion = provideCompletions(project, 'src/example.ts', { line: 0, character: 3 })
    const item = completion.items.find((candidate) => candidate.label === 'helperValue')

    expect(item).toBeDefined()
    expect(item?.detail).toBeTruthy()
    expect(item && 'additionalTextEdits' in item).toBe(false)
  })
})
