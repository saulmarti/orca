import { describe, expect, it, vi } from 'vitest'
import { installRuntimeFileCommandSurface } from './runtime-file-command-surface'

describe('runtime file command surface', () => {
  it('projects plugin workspace read commands onto the runtime service', async () => {
    const readPluginWorkspaceDirectory = vi
      .fn()
      .mockResolvedValue({ path: '', status: 'ok', entries: [] })
    const statPluginWorkspaceFiles = vi.fn().mockResolvedValue([])
    const readPluginWorkspaceFiles = vi.fn().mockResolvedValue([])
    const commands = new Proxy(
      { readPluginWorkspaceDirectory, statPluginWorkspaceFiles, readPluginWorkspaceFiles },
      { get: (subject, key) => Reflect.get(subject, key) ?? vi.fn() }
    )
    const target: Record<string, unknown> = {}

    installRuntimeFileCommandSurface(target as never, commands as never)

    expect(target.readPluginWorkspaceDirectory).toBeTypeOf('function')
    expect(target.statPluginWorkspaceFiles).toBeTypeOf('function')
    expect(target.readPluginWorkspaceFiles).toBeTypeOf('function')
    await (
      target.statPluginWorkspaceFiles as (selector: string, paths: string[]) => Promise<unknown>
    )('id:wt-1', ['src/index.ts'])
    expect(statPluginWorkspaceFiles).toHaveBeenCalledWith('id:wt-1', ['src/index.ts'])
  })
})
