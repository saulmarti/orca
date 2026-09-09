import { fileURLToPath } from 'node:url'
import type {
  EditorCompletionList,
  EditorCompletionRequest,
  EditorDiagnosticsPublication,
  EditorDocumentChange,
  EditorDocumentClose,
  EditorDocumentOpen
} from '../../../src/shared/plugins/plugin-editor-protocol'
import { provideCompletions } from './completion-adapter'
import { adaptDiagnostics } from './diagnostic-adapter'
import { DiagnosticsScheduler } from './diagnostics-scheduler'
import { DocumentStore } from './document-store'
import { ProjectManager } from './project-manager'
import { ProjectResolver } from './project-resolver'
import { WorkspaceFileCache } from './workspace-file-cache'
import { hydrateDocumentProject } from './workspace-hydrator'

const PROVIDER_ID = 'typescript'
const STANDARD_LIB_DIRECTORY = fileURLToPath(new URL('./lib/', import.meta.url))

type Disposable = { dispose(): void }
type Provider = {
  openDocument(document: EditorDocumentOpen): void | Promise<void>
  changeDocument(change: EditorDocumentChange): void | Promise<void>
  closeDocument(document: EditorDocumentClose): void | Promise<void>
  provideCompletions(
    request: EditorCompletionRequest,
    signal: AbortSignal
  ): EditorCompletionList | Promise<EditorCompletionList>
}

type OrcaApi = {
  editor: {
    registerProvider(providerId: string, provider: Provider): Disposable
    publishDiagnostics(providerId: string, publication: EditorDiagnosticsPublication): void
  }
  host: { call(method: string, params?: unknown): Promise<unknown> }
  grantedCapabilities: readonly string[]
  log(message: string): void
}

function emptyCompletion(): EditorCompletionList {
  return { isIncomplete: false, items: [] }
}

export default async function activate(orca: OrcaApi): Promise<() => void> {
  const documents = new DocumentStore()
  const cache = new WorkspaceFileCache()
  const resolver = new ProjectResolver(cache)
  const projects = new ProjectManager({
    documents,
    cache,
    standardLibDirectory: STANDARD_LIB_DIRECTORY
  })
  const documentProjects = new Map<string, string>()
  const projectDocuments = new Map<string, Set<string>>()
  const scheduler = new DiagnosticsScheduler({
    publish(publication) {
      orca.editor.publishDiagnostics(PROVIDER_ID, publication)
    }
  })

  function trackDocument(documentId: string, projectKey: string): void {
    documentProjects.set(documentId, projectKey)
    const ids = projectDocuments.get(projectKey) ?? new Set<string>()
    ids.add(documentId)
    projectDocuments.set(projectKey, ids)
  }

  function releaseDocument(documentId: string): void {
    const projectKey = documentProjects.get(documentId)
    if (!projectKey) {
      return
    }
    documentProjects.delete(documentId)
    const ids = projectDocuments.get(projectKey)
    ids?.delete(documentId)
    if (ids && ids.size > 0) {
      return
    }
    projectDocuments.delete(projectKey)
    projects.invalidate(projectKey)
    cache.releaseProject(projectKey)
  }
  function diagnosticsFor(documentId: string): EditorDiagnosticsPublication {
    const document = documents.getOpenById(documentId)
    const projectKey = documentProjects.get(documentId)
    if (!document || !projectKey) {
      return { documentId, version: 1, diagnostics: [] }
    }
    const project = projects.get(projectKey)
    if (!project) {
      return { documentId, version: document.documentVersion, diagnostics: [] }
    }
    const diagnostics = [
      ...project.getSyntacticDiagnostics(document.relativePath),
      ...project.getSemanticDiagnostics(document.relativePath)
    ]
    return {
      documentId,
      version: document.documentVersion,
      diagnostics: adaptDiagnostics(project, document.relativePath, diagnostics)
    }
  }

  function scheduleDiagnostics(documentId: string): void {
    scheduler.schedule(documentId, () => diagnosticsFor(documentId))
  }

  const provider: Provider = {
    async openDocument(document) {
      documents.open(document)
      const hydrated = await hydrateDocumentProject(orca, cache, resolver, document)
      const project = projects.getOrCreate({
        resolution: hydrated.resolution,
        rootFiles: hydrated.rootFiles,
        ...(hydrated.compilerOptions ? { compilerOptions: hydrated.compilerOptions } : {})
      })
      trackDocument(document.documentId, project.key)
      scheduleDiagnostics(document.documentId)
    },
    changeDocument(change) {
      documents.change(change)
      const projectKey = documentProjects.get(change.documentId)
      if (!projectKey) {
        return
      }
      projects.noteDocumentChange(projectKey)
      scheduleDiagnostics(change.documentId)
    },

    closeDocument(document) {
      scheduler.cancel(document.documentId)
      documents.close(document.documentId, document.finalVersion)
      releaseDocument(document.documentId)
    },

    provideCompletions(request, signal) {
      if (signal.aborted) {
        return emptyCompletion()
      }
      const document = documents.getOpenById(request.documentId)
      const projectKey = documentProjects.get(request.documentId)
      if (!document || !projectKey || document.documentVersion !== request.version) {
        return emptyCompletion()
      }
      const project = projects.get(projectKey)
      if (!project) {
        return emptyCompletion()
      }
      return provideCompletions(project, document.relativePath, request.position)
    }
  }

  const registration = orca.editor.registerProvider(PROVIDER_ID, provider)
  return () => {
    scheduler.dispose()
    registration.dispose()
    projects.dispose()
    documentProjects.clear()
    projectDocuments.clear()
  }
}
