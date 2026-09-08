import type { WorkspaceFileCache } from './workspace-file-cache'

export type ConfiguredProjectResolution = {
  kind: 'configured'
  configRelativePath: string
  key: string
}

export type InferredProjectResolution = {
  kind: 'inferred'
  rootRelativePath: string
  key: string
}

export type ProjectResolution = ConfiguredProjectResolution | InferredProjectResolution

function dirname(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? '' : normalized.slice(0, slash)
}

function join(directory: string, basename: string): string {
  return directory ? `${directory}/${basename}` : basename
}

function ancestors(startDirectory: string): string[] {
  const result: string[] = []
  let current = startDirectory
  while (true) {
    result.push(current)
    if (!current) {
      break
    }
    current = dirname(current)
  }
  return result
}

export class ProjectResolver {
  constructor(private readonly cache: WorkspaceFileCache) {}

  resolve(worktreeId: string, relativePath: string): ProjectResolution {
    const directories = ancestors(dirname(relativePath))
    for (const directory of directories) {
      const tsconfig = join(directory, 'tsconfig.json')
      if (this.cache.hasFile(worktreeId, tsconfig)) {
        return {
          kind: 'configured',
          configRelativePath: tsconfig,
          key: `${worktreeId}\u0000config:${tsconfig}`
        }
      }
      const jsconfig = join(directory, 'jsconfig.json')
      if (this.cache.hasFile(worktreeId, jsconfig)) {
        return {
          kind: 'configured',
          configRelativePath: jsconfig,
          key: `${worktreeId}\u0000config:${jsconfig}`
        }
      }
    }

    for (const directory of directories) {
      if (this.cache.hasFile(worktreeId, join(directory, 'package.json'))) {
        return {
          kind: 'inferred',
          rootRelativePath: directory,
          key: `${worktreeId}\u0000inferred:${directory}`
        }
      }
    }

    return {
      kind: 'inferred',
      rootRelativePath: '',
      key: `${worktreeId}\u0000inferred:`
    }
  }
}
