import { dirname, join, posix } from 'node:path'
import * as ts from '@typescript/typescript6'
import type { EditorPosition } from '../../../src/shared/plugins/plugin-editor-protocol'
import {
  VIRTUAL_ROOT,
  isInside,
  positionAt,
  relativeFromVirtual,
  virtualFileName
} from './typescript-project-paths'
import type { DocumentStore } from './document-store'
import type { WorkspaceFileCache } from './workspace-file-cache'

export const INFERRED_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  allowNonTsExtensions: true,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler
}

type TypeScriptProjectOptions = {
  key: string
  worktreeId: string
  rootRelativePath: string
  documents: DocumentStore
  cache: WorkspaceFileCache
  rootFiles: string[]
  compilerOptions?: ts.CompilerOptions
  standardLibDirectory?: string
}
export class TypeScriptProject {
  readonly key: string
  readonly worktreeId: string
  readonly rootRelativePath: string
  readonly languageService: ts.LanguageService
  private readonly documents: DocumentStore
  private readonly cache: WorkspaceFileCache
  private readonly compilerOptions: ts.CompilerOptions
  private readonly rootFiles: string[]
  private readonly standardLibDirectory: string
  private readonly libSnapshots = new Map<string, ts.IScriptSnapshot>()
  private projectVersion = 1
  private disposed = false

  constructor(options: TypeScriptProjectOptions) {
    this.key = options.key
    this.worktreeId = options.worktreeId
    this.rootRelativePath = options.rootRelativePath
    this.documents = options.documents
    this.cache = options.cache
    this.rootFiles = [...new Set(options.rootFiles.map((path) => path.replace(/\\/g, '/')))]
    this.compilerOptions = { ...INFERRED_COMPILER_OPTIONS, ...options.compilerOptions }
    this.standardLibDirectory =
      options.standardLibDirectory ?? dirname(ts.getDefaultLibFilePath(this.compilerOptions))

    let host: ts.LanguageServiceHost
    host = {
      getCompilationSettings: () => this.compilerOptions,
      getScriptFileNames: () => this.rootFiles.map(virtualFileName),
      getScriptVersion: (fileName) => this.scriptVersion(fileName),
      getScriptSnapshot: (fileName) => this.scriptSnapshot(fileName),
      getCurrentDirectory: () => VIRTUAL_ROOT,
      getDefaultLibFileName: (compilerOptions) =>
        join(this.standardLibDirectory, ts.getDefaultLibFileName(compilerOptions)),
      fileExists: (fileName) => this.fileExists(fileName),
      readFile: (fileName) => this.readFile(fileName),
      readDirectory: (directoryName) => this.readDirectory(directoryName),
      directoryExists: (directoryName) => this.directoryExists(directoryName),
      getDirectories: (directoryName) => this.getDirectories(directoryName),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => ts.sys.newLine,
      getProjectVersion: () => String(this.projectVersion),
      realpath: (fileName) => fileName,
      resolveModuleNames: (moduleNames, containingFile) =>
        moduleNames.map(
          (moduleName) =>
            ts.resolveModuleName(moduleName, containingFile, this.compilerOptions, host)
              .resolvedModule
        )
    }
    this.languageService = ts.createLanguageService(host, ts.createDocumentRegistry())
  }

  getProjectVersion(): number {
    return this.projectVersion
  }

  noteDocumentChange(): void {
    this.assertActive()
    this.projectVersion += 1
  }

  getCompletions(relativePath: string, offset: number): ts.CompletionInfo | undefined {
    this.assertActive()
    return this.languageService.getCompletionsAtPosition(virtualFileName(relativePath), offset, {
      includeCompletionsForModuleExports: true,
      includeCompletionsForImportStatements: true,
      includeCompletionsWithInsertText: true
    })
  }

  getSyntacticDiagnostics(relativePath: string): readonly ts.Diagnostic[] {
    this.assertActive()
    return this.languageService.getSyntacticDiagnostics(virtualFileName(relativePath))
  }

  getSemanticDiagnostics(relativePath: string): readonly ts.Diagnostic[] {
    this.assertActive()
    return this.languageService.getSemanticDiagnostics(virtualFileName(relativePath))
  }

  noteDependencyChange(): void {
    this.noteDocumentChange()
  }

  getText(relativePath: string): string | undefined {
    return (
      this.documents.getOpenByPath(this.worktreeId, relativePath)?.text ??
      (this.cache.getDisk(this.worktreeId, relativePath)?.status === 'file'
        ? (this.cache.getDisk(this.worktreeId, relativePath) as { status: 'file'; text: string })
            .text
        : undefined)
    )
  }

  positionAt(relativePath: string, offset: number): EditorPosition {
    const text = this.getText(relativePath)
    if (text === undefined) {
      throw new Error(`workspace file ${relativePath} is not hydrated`)
    }
    return positionAt(text, offset)
  }

  offsetAt(relativePath: string, position: EditorPosition): number {
    const text = this.getText(relativePath)
    if (text === undefined) {
      throw new Error(`workspace file ${relativePath} is not hydrated`)
    }
    let line = 0
    let lineStart = 0
    while (line < position.line) {
      const newline = text.indexOf('\n', lineStart)
      if (newline === -1) {
        throw new Error('editor position line is outside document')
      }
      lineStart = newline + 1
      line += 1
    }
    const lineEnd = text.indexOf('\n', lineStart)
    const contentEnd = lineEnd === -1 ? text.length : lineEnd
    const offset = lineStart + position.character
    if (offset > contentEnd) {
      throw new Error('editor position character is outside line')
    }
    return offset
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.languageService.dispose()
    this.libSnapshots.clear()
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error(`TypeScript project ${this.key} is disposed`)
    }
  }

  private workspaceText(fileName: string): string | undefined {
    const relativePath = relativeFromVirtual(fileName)
    if (relativePath === null) {
      return undefined
    }
    return this.getText(relativePath)
  }
  private scriptVersion(fileName: string): string {
    const relativePath = relativeFromVirtual(fileName)
    if (relativePath !== null) {
      const overlay = this.documents.getOpenByPath(this.worktreeId, relativePath)
      if (overlay) {
        return String(overlay.scriptVersion)
      }
      const disk = this.cache.getDisk(this.worktreeId, relativePath)
      return disk?.status === 'file' ? String(disk.scriptVersion) : '0'
    }
    return this.isStandardLibrary(fileName) ? '1' : '0'
  }

  private scriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    const workspaceText = this.workspaceText(fileName)
    if (workspaceText !== undefined) {
      return ts.ScriptSnapshot.fromString(workspaceText)
    }
    if (!this.isStandardLibrary(fileName)) {
      return undefined
    }
    const cached = this.libSnapshots.get(fileName)
    if (cached) {
      return cached
    }
    const text = ts.sys.readFile(fileName)
    if (text === undefined) {
      return undefined
    }
    const snapshot = ts.ScriptSnapshot.fromString(text)
    this.libSnapshots.set(fileName, snapshot)
    return snapshot
  }

  private fileExists(fileName: string): boolean {
    const relativePath = relativeFromVirtual(fileName)
    if (relativePath !== null) {
      return Boolean(
        this.documents.getOpenByPath(this.worktreeId, relativePath) ||
        this.cache.getDisk(this.worktreeId, relativePath)?.status === 'file'
      )
    }
    return this.isStandardLibrary(fileName) && ts.sys.fileExists(fileName)
  }

  private readFile(fileName: string): string | undefined {
    const workspaceText = this.workspaceText(fileName)
    if (workspaceText !== undefined) {
      return workspaceText
    }
    return this.isStandardLibrary(fileName) ? ts.sys.readFile(fileName) : undefined
  }

  private readDirectory(directoryName: string): string[] {
    const normalized = directoryName.replace(/\\/g, '/').replace(/\/$/, '')
    if (normalized === VIRTUAL_ROOT || normalized.startsWith(`${VIRTUAL_ROOT}/`)) {
      const prefix =
        normalized === VIRTUAL_ROOT ? '' : `${normalized.slice(VIRTUAL_ROOT.length + 1)}/`
      return this.rootFiles.filter((path) => path.startsWith(prefix)).map(virtualFileName)
    }
    return this.isStandardLibrary(directoryName) ? ts.sys.readDirectory(directoryName) : []
  }

  private directoryExists(directoryName: string): boolean {
    const normalized = directoryName.replace(/\\/g, '/').replace(/\/$/, '')
    if (normalized === VIRTUAL_ROOT) {
      return true
    }
    if (normalized.startsWith(`${VIRTUAL_ROOT}/`)) {
      const relativeDirectory = normalized.slice(VIRTUAL_ROOT.length + 1)
      const prefix = `${relativeDirectory}/`
      return this.rootFiles.some((path) => path.startsWith(prefix))
    }
    return Boolean(this.isStandardLibrary(directoryName) && ts.sys.directoryExists?.(directoryName))
  }

  private getDirectories(directoryName: string): string[] {
    const normalized = directoryName.replace(/\\/g, '/').replace(/\/$/, '')
    if (normalized === VIRTUAL_ROOT || normalized.startsWith(`${VIRTUAL_ROOT}/`)) {
      const prefix =
        normalized === VIRTUAL_ROOT ? '' : `${normalized.slice(VIRTUAL_ROOT.length + 1)}/`
      const directories = new Set<string>()
      for (const path of this.rootFiles) {
        if (!path.startsWith(prefix)) {
          continue
        }
        const remainder = path.slice(prefix.length)
        const slash = remainder.indexOf('/')
        if (slash !== -1) {
          directories.add(posix.join(normalized, remainder.slice(0, slash)))
        }
      }
      return [...directories]
    }
    return this.isStandardLibrary(directoryName)
      ? (ts.sys.getDirectories?.(directoryName) ?? [])
      : []
  }

  private isStandardLibrary(fileName: string): boolean {
    return isInside(this.standardLibDirectory, fileName)
  }
}
