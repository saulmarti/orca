import type * as ts from '@typescript/typescript6'
import type { DocumentStore } from './document-store'
import type { ProjectResolution } from './project-resolver'
import { TypeScriptProject } from './typescript-project'
import type { WorkspaceFileCache, WorkspaceFileInput } from './workspace-file-cache'

type ProjectManagerOptions = {
  documents: DocumentStore
  cache: WorkspaceFileCache
  standardLibDirectory?: string
}

type GetOrCreateProjectOptions = {
  resolution: ProjectResolution
  rootFiles: string[]
  compilerOptions?: ts.CompilerOptions
  standardLibDirectory?: string
}

function worktreeIdFromKey(key: string): string {
  const separator = key.indexOf('\u0000')
  if (separator === -1) {
    throw new Error(`invalid project key ${key}`)
  }
  return key.slice(0, separator)
}

function projectRoot(resolution: ProjectResolution): string {
  if (resolution.kind === 'inferred') {
    return resolution.rootRelativePath
  }
  const slash = resolution.configRelativePath.lastIndexOf('/')
  return slash === -1 ? '' : resolution.configRelativePath.slice(0, slash)
}
export class ProjectManager {
  private readonly projects = new Map<string, TypeScriptProject>()

  constructor(private readonly options: ProjectManagerOptions) {}

  getOrCreate(options: GetOrCreateProjectOptions): TypeScriptProject {
    const existing = this.projects.get(options.resolution.key)
    if (existing) {
      return existing
    }
    const project = new TypeScriptProject({
      key: options.resolution.key,
      worktreeId: worktreeIdFromKey(options.resolution.key),
      rootRelativePath: projectRoot(options.resolution),
      documents: this.options.documents,
      cache: this.options.cache,
      rootFiles: options.rootFiles,
      ...(this.options.standardLibDirectory
        ? { standardLibDirectory: this.options.standardLibDirectory }
        : {}),
      ...(options.compilerOptions ? { compilerOptions: options.compilerOptions } : {}),
      ...(options.standardLibDirectory
        ? { standardLibDirectory: options.standardLibDirectory }
        : {})
    })
    this.projects.set(options.resolution.key, project)
    return project
  }

  get(projectKey: string): TypeScriptProject | undefined {
    return this.projects.get(projectKey)
  }

  noteDocumentChange(projectKey: string): void {
    this.projects.get(projectKey)?.noteDocumentChange()
  }

  refreshDependency(projectKey: string, relativePath: string, input: WorkspaceFileInput): boolean {
    const project = this.projects.get(projectKey)
    if (!project) {
      return false
    }
    const changed = this.options.cache.setFile(projectKey, project.worktreeId, relativePath, input)
    if (changed) {
      project.noteDependencyChange()
    }
    return changed
  }

  invalidate(projectKey: string): void {
    this.projects.get(projectKey)?.dispose()
    this.projects.delete(projectKey)
  }

  dispose(): void {
    for (const project of this.projects.values()) {
      project.dispose()
    }
    this.projects.clear()
  }
}
