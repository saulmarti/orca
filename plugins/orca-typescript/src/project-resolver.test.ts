import { describe, expect, it } from 'vitest'
import { WorkspaceFileCache } from './workspace-file-cache'
import { ProjectResolver } from './project-resolver'

function addFile(cache: WorkspaceFileCache, path: string, text = '{}'): void {
  cache.setFile('bootstrap', 'wt-1', path, {
    text,
    byteLength: Buffer.byteLength(text),
    mtimeMs: 1
  })
}

describe('ProjectResolver', () => {
  it('chooses the nearest config, with tsconfig winning only as a same-directory tie', () => {
    const cache = new WorkspaceFileCache()
    addFile(cache, 'packages/app/tsconfig.json')
    addFile(cache, 'packages/app/src/jsconfig.json')
    const resolver = new ProjectResolver(cache)

    expect(resolver.resolve('wt-1', 'packages/app/src/features/example.ts')).toMatchObject({
      kind: 'configured',
      configRelativePath: 'packages/app/src/jsconfig.json'
    })

    addFile(cache, 'packages/app/src/tsconfig.json')
    expect(resolver.resolve('wt-1', 'packages/app/src/features/example.ts')).toMatchObject({
      kind: 'configured',
      configRelativePath: 'packages/app/src/tsconfig.json'
    })
  })

  it('uses the nearest package.json as inferred root, then falls back to worktree root', () => {
    const cache = new WorkspaceFileCache()
    addFile(cache, 'packages/app/package.json')
    const resolver = new ProjectResolver(cache)

    expect(resolver.resolve('wt-1', 'packages/app/src/example.ts')).toEqual({
      kind: 'inferred',
      rootRelativePath: 'packages/app',
      key: 'wt-1\u0000inferred:packages/app'
    })
    expect(resolver.resolve('wt-1', 'loose/example.ts')).toEqual({
      kind: 'inferred',
      rootRelativePath: '',
      key: 'wt-1\u0000inferred:'
    })
  })

  it('keeps configured projects isolated by worktree and config path', () => {
    const cache = new WorkspaceFileCache()
    addFile(cache, 'packages/a/tsconfig.json')
    addFile(cache, 'packages/b/tsconfig.json')
    const resolver = new ProjectResolver(cache)

    const a = resolver.resolve('wt-1', 'packages/a/src/a.ts')
    const b = resolver.resolve('wt-1', 'packages/b/src/b.ts')
    expect(a.key).toBe('wt-1\u0000config:packages/a/tsconfig.json')
    expect(b.key).toBe('wt-1\u0000config:packages/b/tsconfig.json')
    expect(a.key).not.toBe(b.key)
  })
})
