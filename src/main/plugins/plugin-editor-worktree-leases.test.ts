import { describe, expect, it } from 'vitest'
import { PluginEditorWorktreeLeases } from './plugin-editor-worktree-leases'

describe('PluginEditorWorktreeLeases', () => {
  it('keeps a plugin/worktree lease until its final document releases it', () => {
    const leases = new PluginEditorWorktreeLeases()

    leases.acquire('alpha.tools', 'worktree-1', 'doc-a')
    leases.acquire('alpha.tools', 'worktree-1', 'doc-b')

    expect(leases.has('alpha.tools', 'worktree-1')).toBe(true)
    leases.release('alpha.tools', 'worktree-1', 'doc-a')
    expect(leases.has('alpha.tools', 'worktree-1')).toBe(true)
    leases.release('alpha.tools', 'worktree-1', 'doc-b')
    expect(leases.has('alpha.tools', 'worktree-1')).toBe(false)
  })

  it('revokes every worktree lease owned by one plugin only', () => {
    const leases = new PluginEditorWorktreeLeases()
    leases.acquire('alpha.tools', 'worktree-1', 'doc-a')
    leases.acquire('alpha.tools', 'worktree-2', 'doc-b')
    leases.acquire('beta.tools', 'worktree-1', 'doc-c')

    leases.revokePlugin('alpha.tools')

    expect(leases.has('alpha.tools', 'worktree-1')).toBe(false)
    expect(leases.has('alpha.tools', 'worktree-2')).toBe(false)
    expect(leases.has('beta.tools', 'worktree-1')).toBe(true)
  })
})
