import { describe, expect, it, vi } from 'vitest'
import {
  getSshFilesystemProviderMock,
  openMock,
  readdirMock,
  resolveAuthorizedPathMock,
  statMock
} from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock('../ipc/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./orca-runtime-files-mock-registry')).sshFilesystemDispatchMock
)

function sshCommands(provider: Record<string, unknown>) {
  getSshFilesystemProviderMock.mockReturnValue(provider)
  return createRuntimeFileCommands({
    resolveRuntimeFileTarget: vi.fn(async () => ({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
      executionHostId: 'ssh:ssh-1'
    }))
  }).commands
}

describe('plugin workspace runtime reads', () => {
  useRuntimeFileCommandsLifecycle()
  it('rejects a canonical target that escapes the selected worktree', async () => {
    const { commands } = createRuntimeFileCommands({ path: '/repo' })
    resolveAuthorizedPathMock
      .mockResolvedValueOnce('/repo')
      .mockResolvedValueOnce('/outside/secret.ts')

    await expect(commands.statPluginWorkspaceFiles('id:wt-1', ['link/secret.ts'])).rejects.toThrow(
      /outside|worktree/i
    )
  })

  it('rejects traversal before reaching filesystem authorization', async () => {
    const { commands } = createRuntimeFileCommands({ path: '/repo' })

    await expect(
      commands.readPluginWorkspaceFiles('id:wt-1', ['../secret.ts'], 1024)
    ).rejects.toThrow('invalid_relative_path')
    expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
  })

  it('returns stat metadata through the local runtime route', async () => {
    const { commands } = createRuntimeFileCommands({ path: '/repo' })
    resolveAuthorizedPathMock
      .mockResolvedValueOnce('/repo')
      .mockResolvedValueOnce('/repo/src/index.ts')
    statMock.mockResolvedValue({ size: 7, isDirectory: () => false, mtimeMs: 88 })

    await expect(commands.statPluginWorkspaceFiles('id:wt-1', ['src/index.ts'])).resolves.toEqual([
      { path: 'src/index.ts', status: 'ok', type: 'file', byteLength: 7, mtimeMs: 88 }
    ])
  })

  it('reads bounded text through the local runtime route', async () => {
    const { commands } = createRuntimeFileCommands({ path: '/repo' })
    resolveAuthorizedPathMock
      .mockResolvedValueOnce('/repo')
      .mockResolvedValueOnce('/repo/src/index.ts')
    statMock.mockResolvedValue({ size: 3, isDirectory: () => false, mtimeMs: 77 })
    const handle = {
      stat: vi.fn(async () => ({ size: 3, mtimeMs: 77 })),
      read: vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
        if (length === 1) {
          return { bytesRead: 0 }
        }
        buffer.write('abc')
        return { bytesRead: 3 }
      }),
      close: vi.fn(async () => undefined)
    }
    openMock.mockResolvedValue(handle)

    await expect(
      commands.readPluginWorkspaceFiles('id:wt-1', ['src/index.ts'], 10)
    ).resolves.toEqual([
      { path: 'src/index.ts', status: 'ok', content: 'abc', byteLength: 3, mtimeMs: 77 }
    ])
  })

  it('returns stat metadata and a per-path missing status over SSH', async () => {
    const provider = {
      realpath: vi.fn(async (path: string) => {
        if (path.endsWith('missing.ts')) {
          throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
        }
        return path
      }),
      stat: vi.fn(async (path: string) => ({
        size: path.endsWith('dir') ? 0 : 12,
        type: path.endsWith('dir') ? 'directory' : 'file',
        mtime: 1234
      }))
    }
    const commands = sshCommands(provider)

    await expect(
      commands.statPluginWorkspaceFiles('id:wt-1', ['src/index.ts', 'src/dir', 'src/missing.ts'])
    ).resolves.toEqual([
      { path: 'src/index.ts', status: 'ok', type: 'file', byteLength: 12, mtimeMs: 1234 },
      { path: 'src/dir', status: 'ok', type: 'directory', byteLength: 0, mtimeMs: 1234 },
      { path: 'src/missing.ts', status: 'missing' }
    ])
  })

  it('returns text and per-path non-file/too-large/binary statuses without truncation', async () => {
    const provider = {
      realpath: vi.fn(async (path: string) => path),
      stat: vi.fn(async (path: string) => ({
        size: path.endsWith('big.ts') ? 11 : path.endsWith('dir') ? 0 : 3,
        type: path.endsWith('dir') ? 'directory' : 'file',
        mtime: 55
      })),
      readFile: vi.fn(async (path: string) =>
        path.endsWith('binary.ts')
          ? { content: '', isBinary: true }
          : { content: 'abc', isBinary: false }
      )
    }
    const commands = sshCommands(provider)

    await expect(
      commands.readPluginWorkspaceFiles(
        'id:wt-1',
        ['src/index.ts', 'src/dir', 'src/big.ts', 'src/binary.ts'],
        10
      )
    ).resolves.toEqual([
      { path: 'src/index.ts', status: 'ok', content: 'abc', byteLength: 3, mtimeMs: 55 },
      { path: 'src/dir', status: 'not-file' },
      { path: 'src/big.ts', status: 'too-large' },
      { path: 'src/binary.ts', status: 'binary' }
    ])
    expect(provider.readFile).toHaveBeenCalledTimes(2)
  })
  it('reads one shallow directory through the local runtime route', async () => {
    const { commands } = createRuntimeFileCommands({ path: '/repo' })
    resolveAuthorizedPathMock.mockResolvedValueOnce('/repo').mockResolvedValueOnce('/repo/src')
    statMock.mockResolvedValue({ size: 0, isDirectory: () => true, mtimeMs: 1 })
    readdirMock.mockResolvedValue([
      { name: 'a.ts', isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'nested', isDirectory: () => true, isSymbolicLink: () => false }
    ])

    await expect(commands.readPluginWorkspaceDirectory('id:wt-1', 'src', 2048)).resolves.toEqual({
      path: 'src',
      status: 'ok',
      entries: [
        { name: 'a.ts', path: 'src/a.ts' },
        { name: 'nested', path: 'src/nested' }
      ]
    })
  })

  it('rejects a directory result that exceeds its explicit entry budget', async () => {
    const { commands } = createRuntimeFileCommands({ path: '/repo' })
    resolveAuthorizedPathMock.mockResolvedValueOnce('/repo').mockResolvedValueOnce('/repo/src')
    statMock.mockResolvedValue({ size: 0, isDirectory: () => true, mtimeMs: 1 })
    readdirMock.mockResolvedValue([
      { name: 'a.ts', isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'b.ts', isDirectory: () => false, isSymbolicLink: () => false }
    ])

    await expect(commands.readPluginWorkspaceDirectory('id:wt-1', 'src', 1)).rejects.toThrow(
      /limit/i
    )
  })

  it('returns missing/not-directory directory statuses over SSH', async () => {
    const provider = {
      realpath: vi.fn(async (path: string) => {
        if (path.endsWith('missing')) {
          throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
        }
        return path
      }),
      stat: vi.fn(async (path: string) => ({
        size: 1,
        type: path.endsWith('.ts') ? 'file' : 'directory',
        mtime: 1
      })),
      readDir: vi.fn(async () => [])
    }
    const commands = sshCommands(provider)

    await expect(
      commands.readPluginWorkspaceDirectory('id:wt-1', 'missing', 2048)
    ).resolves.toEqual({ path: 'missing', status: 'missing' })
    await expect(
      commands.readPluginWorkspaceDirectory('id:wt-1', 'src/index.ts', 2048)
    ).resolves.toEqual({ path: 'src/index.ts', status: 'not-directory' })
    expect(provider.readDir).not.toHaveBeenCalled()
  })
})
