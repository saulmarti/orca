import { describe, expect, it } from 'vitest'
import type {
  EditorDocumentChange,
  EditorDocumentOpen
} from '../../../src/shared/plugins/plugin-editor-protocol'
import { DocumentStore } from './document-store'

function openDocument(overrides: Partial<EditorDocumentOpen> = {}): EditorDocumentOpen {
  return {
    documentId: 'doc-1',
    worktreeId: 'wt-1',
    filePath: '/repo/src/example.ts',
    relativePath: 'src/example.ts',
    languageId: 'typescript',
    version: 1,
    text: "const value = '😀a'\n",
    ...overrides
  }
}

function change(version: number, changes: EditorDocumentChange['changes']): EditorDocumentChange {
  return { documentId: 'doc-1', version, changes }
}
describe('DocumentStore', () => {
  it('applies zero-based UTF-16 incremental edits and advances script versions', () => {
    const store = new DocumentStore()
    store.open(openDocument())
    const line = "const value = '😀a'"
    const aOffset = line.indexOf('a', line.indexOf('😀'))

    store.change(
      change(2, [
        {
          range: {
            start: { line: 0, character: aOffset },
            end: { line: 0, character: aOffset + 1 }
          },
          rangeLength: 1,
          text: 'bc'
        }
      ])
    )

    expect(store.getOpenById('doc-1')).toMatchObject({
      documentVersion: 2,
      scriptVersion: 2,
      text: "const value = '😀bc'\n"
    })
  })

  it('rejects non-monotonic versions and inconsistent range lengths', () => {
    const store = new DocumentStore()
    store.open(openDocument())

    expect(() =>
      store.change(
        change(1, [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            rangeLength: 1,
            text: 'C'
          }
        ])
      )
    ).toThrow(/version/i)

    expect(() =>
      store.change(
        change(2, [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            rangeLength: 2,
            text: 'C'
          }
        ])
      )
    ).toThrow(/rangeLength/i)
  })

  it('falls back to disk after close and removes temporary overlays', () => {
    const disk = new Map<string, string>([['wt-1\0src/example.ts', 'const disk = true\n']])
    const store = new DocumentStore()
    const readDisk = (worktreeId: string, relativePath: string) =>
      disk.get(`${worktreeId}\0${relativePath}`)

    store.open(openDocument())
    expect(store.resolveText('wt-1', 'src/example.ts', readDisk)).toBe("const value = '😀a'\n")
    store.close('doc-1', 1)
    expect(store.resolveText('wt-1', 'src/example.ts', readDisk)).toBe('const disk = true\n')

    store.open(
      openDocument({
        documentId: 'temp-1',
        filePath: '/repo/src/temp.ts',
        relativePath: 'src/temp.ts'
      })
    )
    store.close('temp-1', 1)
    expect(store.resolveText('wt-1', 'src/temp.ts', readDisk)).toBeUndefined()
    expect(store.getOpenByPath('wt-1', 'src/temp.ts')).toBeUndefined()
  })
})
