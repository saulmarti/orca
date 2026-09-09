import { posix } from 'node:path'
import * as ts from '@typescript/typescript6'
import type { EditorDocumentOpen } from '../../../src/shared/plugins/plugin-editor-protocol'
import type { ProjectResolution, ProjectResolver } from './project-resolver'
import type { WorkspaceFileCache } from './workspace-file-cache'
import {
  readWorkspaceDirectory,
  readWorkspacePaths,
  statWorkspacePaths,
  type OrcaHost,
  type WorkspaceReadResult
} from './workspace-host-client'

const MAX_DISCOVERED_ENTRIES = 4_096
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.orca',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage'
])

type HydratedProject = {
  resolution: ProjectResolution
  rootFiles: string[]
  compilerOptions?: ts.CompilerOptions
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? '' : normalized.slice(0, slash)
}

function ancestors(path: string): string[] {
  const result: string[] = []
  let current = path
  while (true) {
    result.push(current)
    if (!current) {
      break
    }
    current = dirname(current)
  }
  return result
}

function join(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name
}

async function hydrateAncestorMarkers(
  orca: OrcaHost,
  cache: WorkspaceFileCache,
  document: EditorDocumentOpen
): Promise<void> {
  const bootstrapKey = `${document.worktreeId}\u0000bootstrap`
  const candidates = ancestors(dirname(document.relativePath)).flatMap((directory) => [
    join(directory, 'tsconfig.json'),
    join(directory, 'jsconfig.json'),
    join(directory, 'package.json')
  ])
  const stats = await statWorkspacePaths(orca, document.worktreeId, candidates)
  const readable = stats
    .filter((result) => result.status === 'ok' && result.type === 'file')
    .map((result) => result.path)
  const contents = new Map(
    (await readWorkspacePaths(orca, document.worktreeId, readable))
      .filter(
        (result): result is Extract<WorkspaceReadResult, { status: 'ok' }> => result.status === 'ok'
      )
      .map((result) => [result.path, result])
  )
  for (const candidate of candidates) {
    const content = contents.get(candidate)
    if (content) {
      cache.setFile(bootstrapKey, document.worktreeId, candidate, {
        text: content.content,
        byteLength: content.byteLength,
        mtimeMs: content.mtimeMs
      })
    } else {
      cache.setMissing(bootstrapKey, document.worktreeId, candidate)
    }
  }
}

function resolutionRoot(resolution: ProjectResolution): string {
  if (resolution.kind === 'inferred') {
    return resolution.rootRelativePath
  }
  return dirname(resolution.configRelativePath)
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) || path.endsWith('.d.ts')
}

function shouldReadMetadata(path: string): boolean {
  const name = posix.basename(path)
  return (
    isSourceFile(path) ||
    name === 'tsconfig.json' ||
    name === 'jsconfig.json' ||
    name === 'package.json'
  )
}

async function discoverProjectTree(
  orca: OrcaHost,
  worktreeId: string,
  root: string
): Promise<{ files: string[]; directories: Set<string> }> {
  const files: string[] = []
  const directories = new Set<string>([root])
  const queue = [root]
  let discovered = 0

  while (queue.length > 0) {
    const directory = queue.shift()!
    const entries = await readWorkspaceDirectory(orca, worktreeId, directory)
    discovered += entries.length
    if (discovered > MAX_DISCOVERED_ENTRIES) {
      throw new Error(`TypeScript project exceeds ${MAX_DISCOVERED_ENTRIES} discovered entries`)
    }
    const stats = await statWorkspacePaths(
      orca,
      worktreeId,
      entries.map((entry) => entry.path)
    )
    for (const stat of stats) {
      if (stat.status !== 'ok') {
        continue
      }
      if (stat.type === 'directory') {
        const basename = posix.basename(stat.path)
        if (!SKIPPED_DIRECTORIES.has(basename)) {
          directories.add(stat.path)
          queue.push(stat.path)
        }
        continue
      }
      if (stat.type === 'file' && shouldReadMetadata(stat.path)) {
        files.push(stat.path)
      }
    }
  }

  return { files, directories }
}

async function hydrateDiscoveredFiles(
  orca: OrcaHost,
  cache: WorkspaceFileCache,
  projectKey: string,
  worktreeId: string,
  files: string[]
): Promise<void> {
  for (const result of await readWorkspacePaths(orca, worktreeId, files)) {
    if (result.status !== 'ok') {
      continue
    }
    cache.setFile(projectKey, worktreeId, result.path, {
      text: result.content,
      byteLength: result.byteLength,
      mtimeMs: result.mtimeMs
    })
  }
}

function directEntries(
  directory: string,
  files: readonly string[],
  directories: ReadonlySet<string>
): { files: string[]; directories: string[] } {
  const fileNames = files
    .filter((path) => dirname(path) === directory)
    .map((path) => posix.basename(path))
  const directoryNames = [...directories]
    .filter((path) => path !== directory && dirname(path) === directory)
    .map((path) => posix.basename(path))
  return { files: fileNames, directories: directoryNames }
}

function normalizeMatchedPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '')
}

type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => { files: string[]; directories: string[] },
  realpath: (path: string) => string
) => string[]

function matchConfiguredFiles(
  root: string,
  extensions: readonly string[],
  exclude: readonly string[] | undefined,
  include: readonly string[] | undefined,
  files: readonly string[],
  directories: ReadonlySet<string>
): string[] {
  const matchFiles = (ts as unknown as { matchFiles?: MatchFiles }).matchFiles
  if (!matchFiles) {
    throw new Error('TypeScript 6 runtime does not expose matchFiles')
  }
  return matchFiles(
    root,
    extensions,
    exclude,
    include,
    true,
    '',
    undefined,
    (directory) => directEntries(normalizeMatchedPath(directory), files, directories),
    (path) => path
  ).map(normalizeMatchedPath)
}

function configuredProject(
  cache: WorkspaceFileCache,
  resolution: Extract<ProjectResolution, { kind: 'configured' }>,
  worktreeId: string,
  files: readonly string[],
  directories: ReadonlySet<string>,
  log: (message: string) => void
): { rootFiles: string[]; compilerOptions: ts.CompilerOptions } {
  const configRecord = cache.getDisk(worktreeId, resolution.configRelativePath)
  const configText = configRecord?.status === 'file' ? configRecord.text : '{}'
  const parsedJson = ts.parseConfigFileTextToJson(resolution.configRelativePath, configText)
  if (parsedJson.error) {
    log(ts.flattenDiagnosticMessageText(parsedJson.error.messageText, '\n'))
  }
  const config = parsedJson.config ?? {}
  const root = dirname(resolution.configRelativePath)
  const converted = ts.convertCompilerOptionsFromJson(config.compilerOptions ?? {}, root)
  for (const error of converted.errors) {
    log(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  }
  const compilerOptions: ts.CompilerOptions = {
    ...converted.options,
    ...(resolution.configRelativePath.endsWith('jsconfig.json') &&
    converted.options.allowJs === undefined
      ? { allowJs: true }
      : {})
  }
  const extensions = compilerOptions.allowJs ? SOURCE_EXTENSIONS : ['.ts', '.tsx', '.mts', '.cts']
  const rootFiles = Array.isArray(config.files)
    ? config.files.map((path: string) => normalizeMatchedPath(posix.join(root, path)))
    : matchConfiguredFiles(
        root,
        extensions,
        Array.isArray(config.exclude) ? config.exclude : undefined,
        Array.isArray(config.include) ? config.include : ['**/*'],
        files,
        directories
      )
  return { rootFiles, compilerOptions }
}

export async function hydrateDocumentProject(
  orca: OrcaHost,
  cache: WorkspaceFileCache,
  resolver: ProjectResolver,
  document: EditorDocumentOpen
): Promise<HydratedProject> {
  await hydrateAncestorMarkers(orca, cache, document)
  const resolution = resolver.resolve(document.worktreeId, document.relativePath)
  const root = resolutionRoot(resolution)
  const discovered = await discoverProjectTree(orca, document.worktreeId, root)
  await hydrateDiscoveredFiles(orca, cache, resolution.key, document.worktreeId, discovered.files)

  const configured =
    resolution.kind === 'configured'
      ? configuredProject(
          cache,
          resolution,
          document.worktreeId,
          discovered.files,
          discovered.directories,
          (message) => orca.log(message)
        )
      : undefined
  const rootFiles = configured?.rootFiles ?? discovered.files.filter(isSourceFile)
  if (!rootFiles.includes(document.relativePath)) {
    rootFiles.push(document.relativePath)
  }
  return {
    resolution,
    rootFiles,
    ...(configured ? { compilerOptions: configured.compilerOptions } : {})
  }
}
