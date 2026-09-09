import { describe, expect, it } from 'vitest'
import { DocumentStore } from './document-store'
import { WorkspaceFileCache } from './workspace-file-cache'

function file(text: string, mtimeMs = 1) {
  return { text, byteLength: Buffer.byteLength(text), mtimeMs }
}

describe('WorkspaceFileCache', () => {
  it('lets open document overlays override disk snapshots without copying them into cache', () => {
    const cache = new WorkspaceFileCache()
    const documents = new DocumentStore()
    cache.setFile('project-a', 'wt-1', 'src/a.ts', file('disk'))
    documents.open({
      documentId: 'doc-a',
      worktreeId: 'wt-1',
      filePath: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      languageId: 'typescript',
      version: 1,
      text: 'overlay'
    })

    expect(cache.resolveText(documents, 'wt-1', 'src/a.ts')).toBe('overlay')
    documents.close('doc-a', 1)
    expect(cache.resolveText(documents, 'wt-1', 'src/a.ts')).toBe('disk')
  })

  it('caches known-missing paths and increments script versions only for changed files', () => {
    const cache = new WorkspaceFileCache()
    cache.setMissing('project-a', 'wt-1', 'src/missing.ts')
    expect(cache.getDisk('wt-1', 'src/missing.ts')).toEqual({ status: 'missing' })

    cache.setFile('project-a', 'wt-1', 'src/a.ts', file('one', 1))
    expect(cache.getDisk('wt-1', 'src/a.ts')).toMatchObject({ status: 'file', scriptVersion: 1 })
    cache.setFile('project-a', 'wt-1', 'src/a.ts', file('one', 1))
    expect(cache.getDisk('wt-1', 'src/a.ts')).toMatchObject({ status: 'file', scriptVersion: 1 })
    cache.setFile('project-a', 'wt-1', 'src/a.ts', file('two', 2))
    expect(cache.getDisk('wt-1', 'src/a.ts')).toMatchObject({ status: 'file', scriptVersion: 2 })
  })

  it('evicts least-recently-used unpinned files at project and worker byte budgets', () => {
    const cache = new WorkspaceFileCache({ projectByteBudget: 6, workerByteBudget: 10 })
    cache.setFile('project-a', 'wt-1', 'a.ts', file('aaaa'))
    cache.setFile('project-a', 'wt-1', 'b.ts', file('bbbb'))
    expect(cache.getDisk('wt-1', 'a.ts')).toBeUndefined()
    expect(cache.getDisk('wt-1', 'b.ts')).toMatchObject({ status: 'file' })

    cache.setFile('project-b', 'wt-1', 'c.ts', file('cccc'))
    cache.setFile('project-c', 'wt-1', 'd.ts', file('dddd'))
    expect(cache.totalTextBytes()).toBeLessThanOrEqual(10)
    expect(cache.projectTextBytes('project-b')).toBeLessThanOrEqual(6)
  })
})

it('releases project ownership without deleting files still shared by another project', () => {
  const cache = new WorkspaceFileCache()
  cache.setFile('project-a', 'wt-1', 'src/shared.ts', file('shared'))
  cache.setFile('project-b', 'wt-1', 'src/shared.ts', file('shared'))
  cache.setFile('project-a', 'wt-1', 'src/only-a.ts', file('only-a'))

  cache.releaseProject('project-a')

  expect(cache.getDisk('wt-1', 'src/only-a.ts')).toBeUndefined()
  expect(cache.getDisk('wt-1', 'src/shared.ts')).toMatchObject({ status: 'file', text: 'shared' })
})
