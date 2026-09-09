// @ts-nocheck -- mechanically extends the split RuntimeFileCommands class chain.
import { readdir, stat } from 'node:fs/promises'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { isENOENT } from '../ipc/filesystem-path-containment'
import {
  requireRuntimeFileProvider,
  type RuntimeFileExplorerPath
} from './runtime-file-command-target'
import { isBinaryBuffer } from './runtime-file-command-host'
import { RuntimeFileCommandsWithSearchRemoteQuickOpenFilePaths } from './runtime-file-commands-search-remote-quick-open-file-paths'
import { normalizeRuntimeRelativePath } from './runtime-relative-paths'

export type PluginWorkspaceStatResult = {
  path: string
  status: 'ok' | 'missing'
  type?: 'file' | 'directory'
  byteLength?: number
  mtimeMs?: number
}
export type PluginWorkspaceReadResult =
  | { path: string; status: 'ok'; content: string; byteLength: number; mtimeMs: number }
  | { path: string; status: 'missing' | 'not-file' | 'too-large' | 'binary' }

type CanonicalPluginWorkspacePath = {
  target: RuntimeFileExplorerPath
  canonicalPath: string
  provider: ReturnType<typeof requireRuntimeFileProvider>
}

export class RuntimeFileCommandsWithPluginWorkspaceFiles extends RuntimeFileCommandsWithSearchRemoteQuickOpenFilePaths {
  private async canonicalPluginWorkspacePaths(
    worktreeSelector: string,
    relativePaths: readonly string[]
  ): Promise<(CanonicalPluginWorkspacePath | null)[]> {
    const normalizedPaths = relativePaths.map((path) => normalizeRuntimeRelativePath(path))
    const rootTarget = await this.resolveFileExplorerPath(worktreeSelector, '')
    const provider = requireRuntimeFileProvider(rootTarget)
    const canonicalRoot = provider
      ? await provider.realpath(rootTarget.path)
      : await resolveAuthorizedPath(rootTarget.path, this.host.requireStore())

    return Promise.all(
      normalizedPaths.map(async (relativePath) => {
        const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
        let canonicalPath: string
        try {
          canonicalPath = provider
            ? await provider.realpath(target.path)
            : await resolveAuthorizedPath(target.path, this.host.requireStore())
        } catch (error) {
          if (isENOENT(error)) {
            return null
          }
          throw error
        }
        if (!isPathInsideOrEqual(canonicalRoot, canonicalPath)) {
          throw new Error('plugin workspace path resolves outside the leased worktree')
        }
        return { target, canonicalPath, provider }
      })
    )
  }

  async readPluginWorkspaceDirectory(
    worktreeSelector: string,
    relativePath: string,
    maxEntries: number
  ): Promise<
    | { path: string; status: 'ok'; entries: { name: string; path: string }[] }
    | { path: string; status: 'missing' | 'not-directory' }
  > {
    const [entry] = await this.canonicalPluginWorkspacePaths(worktreeSelector, [relativePath])
    if (!entry) {
      return { path: relativePath, status: 'missing' }
    }
    try {
      const fileStat = entry.provider
        ? await entry.provider.stat(entry.canonicalPath)
        : await stat(entry.canonicalPath)
      const isDirectory = fileStat.type === 'directory' || fileStat.isDirectory?.() === true
      if (!isDirectory) {
        return { path: relativePath, status: 'not-directory' }
      }
      const entries = entry.provider
        ? await entry.provider.readDir(entry.canonicalPath)
        : await readdir(entry.canonicalPath, { withFileTypes: true })
      if (entries.length > maxEntries) {
        throw new Error('plugin workspace directory entry limit exceeded')
      }
      const prefix = relativePath ? `${relativePath}/` : ''
      return {
        path: relativePath,
        status: 'ok',
        entries: entries.map((candidate) => ({
          name: candidate.name,
          path: `${prefix}${candidate.name}`
        }))
      }
    } catch (error) {
      if (isENOENT(error)) {
        return { path: relativePath, status: 'missing' }
      }
      throw error
    }
  }

  async statPluginWorkspaceFiles(
    worktreeSelector: string,
    relativePaths: readonly string[]
  ): Promise<PluginWorkspaceStatResult[]> {
    const resolved = await this.canonicalPluginWorkspacePaths(worktreeSelector, relativePaths)
    return Promise.all(
      resolved.map(async (entry, index) => {
        const path = relativePaths[index]!
        if (!entry) {
          return { path, status: 'missing' as const }
        }
        try {
          const fileStat = entry.provider
            ? await entry.provider.stat(entry.canonicalPath)
            : await stat(entry.canonicalPath)
          return {
            path,
            status: 'ok' as const,
            type: fileStat.type === 'directory' || fileStat.isDirectory?.() ? 'directory' : 'file',
            byteLength: fileStat.size,
            mtimeMs: fileStat.mtimeMs ?? fileStat.mtime
          }
        } catch (error) {
          if (isENOENT(error)) {
            return { path, status: 'missing' as const }
          }
          throw error
        }
      })
    )
  }
  async readPluginWorkspaceFiles(
    worktreeSelector: string,
    relativePaths: readonly string[],
    maxFileBytes: number
  ): Promise<PluginWorkspaceReadResult[]> {
    const resolved = await this.canonicalPluginWorkspacePaths(worktreeSelector, relativePaths)
    return Promise.all(
      resolved.map(async (entry, index) => {
        const path = relativePaths[index]!
        if (!entry) {
          return { path, status: 'missing' as const }
        }
        try {
          const fileStat = entry.provider
            ? await entry.provider.stat(entry.canonicalPath)
            : await stat(entry.canonicalPath)
          const isDirectory = fileStat.type === 'directory' || fileStat.isDirectory?.() === true
          if (isDirectory) {
            return { path, status: 'not-file' as const }
          }
          if (fileStat.size > maxFileBytes) {
            return { path, status: 'too-large' as const }
          }
          if (entry.provider) {
            const result = await entry.provider.readFile(entry.canonicalPath, {
              maxTextBytes: maxFileBytes,
              maxBinaryBytes: maxFileBytes
            })
            if (result.isBinary) {
              return { path, status: 'binary' as const }
            }
            const byteLength = Buffer.byteLength(result.content, 'utf8')
            if (byteLength > maxFileBytes) {
              return { path, status: 'too-large' as const }
            }
            return {
              path,
              status: 'ok' as const,
              content: result.content,
              byteLength,
              mtimeMs: fileStat.mtimeMs ?? fileStat.mtime
            }
          }
          const { buffer, stats } = await readNodeFileWithinLimit(entry.canonicalPath, maxFileBytes)
          if (isBinaryBuffer(buffer)) {
            return { path, status: 'binary' as const }
          }
          return {
            path,
            status: 'ok' as const,
            content: buffer.toString('utf8'),
            byteLength: buffer.byteLength,
            mtimeMs: stats.mtimeMs
          }
        } catch (error) {
          if (isENOENT(error)) {
            return { path, status: 'missing' as const }
          }
          if (error instanceof NodeFileReadTooLargeError) {
            return { path, status: 'too-large' as const }
          }
          throw error
        }
      })
    )
  }
}
