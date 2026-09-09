import { describe, expect, it } from 'vitest'
import { getPluginHostMethodSpec } from './plugin-host-api'

const methods = ['workspace.readDirectory', 'workspace.statFiles', 'workspace.readFiles'] as const

describe('workspace file host API contracts', () => {
  it.each(methods)('is worker-only and gated by workspace:readFiles: %s', (method) => {
    const spec = getPluginHostMethodSpec(method)
    expect(spec).not.toBeNull()
    expect(spec?.panel).toBe(false)
    expect(spec?.capability).toBe('workspace:readFiles')
    expect(spec?.mutation).toBe(false)
  })

  it('accepts only normalized relative directory paths', () => {
    const schema = getPluginHostMethodSpec('workspace.readDirectory')!.params
    expect(schema.safeParse({ worktreeId: 'wt-1', path: '' }).success).toBe(true)
    expect(schema.safeParse({ worktreeId: 'wt-1', path: 'src' }).success).toBe(true)
    expect(schema.safeParse({ worktreeId: 'wt-1', path: '../src' }).success).toBe(false)
    expect(schema.safeParse({ worktreeId: 'wt-1', path: '/tmp' }).success).toBe(false)
  })

  it('caps file batches at 256 and rejects traversal', () => {
    const schema = getPluginHostMethodSpec('workspace.statFiles')!.params
    expect(schema.safeParse({ worktreeId: 'wt-1', paths: ['src/index.ts'] }).success).toBe(true)
    expect(schema.safeParse({ worktreeId: 'wt-1', paths: ['../secret.ts'] }).success).toBe(false)
    expect(
      schema.safeParse({ worktreeId: 'wt-1', paths: Array.from({ length: 257 }, () => 'a.ts') })
        .success
    ).toBe(false)
  })

  it('enforces the aggregate read response content budget', () => {
    const schema = getPluginHostMethodSpec('workspace.readFiles')!.result
    const overBudget = 'x'.repeat(8 * 1024 * 1024 + 1)
    expect(
      schema.safeParse({
        results: [
          {
            path: 'src/index.ts',
            status: 'ok',
            content: overBudget,
            byteLength: overBudget.length,
            mtimeMs: 1
          }
        ]
      }).success
    ).toBe(false)
  })
})
