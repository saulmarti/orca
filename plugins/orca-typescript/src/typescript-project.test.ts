import { describe, expect, it } from 'vitest'
import { DocumentStore } from './document-store'
import { WorkspaceFileCache } from './workspace-file-cache'
import { TypeScriptProject } from './typescript-project'

function addFile(cache: WorkspaceFileCache, projectKey: string, path: string, text: string): void {
  cache.setFile(projectKey, 'wt-1', path, {
    text,
    byteLength: Buffer.byteLength(text),
    mtimeMs: 1
  })
}

function marked(source: string): { text: string; offset: number } {
  const offset = source.indexOf('|')
  expect(offset).toBeGreaterThanOrEqual(0)
  return { text: source.slice(0, offset) + source.slice(offset + 1), offset }
}

function projectWith(files: Record<string, string>) {
  const cache = new WorkspaceFileCache()
  const documents = new DocumentStore()
  const key = 'wt-1\u0000inferred:'
  for (const [path, text] of Object.entries(files)) {
    addFile(cache, key, path, text)
  }
  const project = new TypeScriptProject({
    key,
    worktreeId: 'wt-1',
    rootRelativePath: '',
    documents,
    cache,
    rootFiles: Object.keys(files)
  })
  return { cache, documents, project }
}

describe('TypeScriptProject completions', () => {
  it.each([
    ["const user = { name: 'Saul', age: 1 }\nuser.na|", 'name'],
    ['interface User { email: string }\ndeclare const user: User\nuser.em|', 'email'],
    ['const localValue = 1\nloc|', 'localValue']
  ])('provides inferred typed completion %s', (source, expected) => {
    const input = marked(source)
    const { project } = projectWith({ 'src/example.ts': input.text })

    const entries = project.getCompletions('src/example.ts', input.offset)?.entries ?? []
    expect(entries.some((entry) => entry.name === expected)).toBe(true)
  })

  it('loads the bundled TypeScript standard library for built-in types', () => {
    const input = marked('const values: string[] = []\nvalues.ma|')
    const { project } = projectWith({ 'src/example.ts': input.text })

    const entries = project.getCompletions('src/example.ts', input.offset)?.entries ?? []
    expect(entries.some((entry) => entry.name === 'map')).toBe(true)
  })

  it('resolves relative imports from hydrated project files', () => {
    const input = marked("import type { User } from './user'\ndeclare const user: User\nuser.na|")
    const { project } = projectWith({
      'src/user.ts': 'export interface User { name: string }',
      'src/example.ts': input.text
    })

    const entries = project.getCompletions('src/example.ts', input.offset)?.entries ?? []
    expect(entries.some((entry) => entry.name === 'name')).toBe(true)
  })

  it('surfaces auto-import candidates without applying import edits', () => {
    const input = marked('hel|')
    const { project } = projectWith({
      'src/util.ts': 'export const helperValue = 1',
      'src/example.ts': input.text
    })

    const entry = project
      .getCompletions('src/example.ts', input.offset)
      ?.entries.find((candidate) => candidate.name === 'helperValue')
    expect(entry).toBeDefined()
    expect(entry?.source).toBeTruthy()
  })

  it.each([
    [
      'src/example.tsx',
      "type Props = { title: string }\nconst props: Props = { title: 'x' }\nconst node = <div>{props.ti|}</div>",
      'title'
    ],
    ['src/example.jsx', "const user = { name: 'x' }\nconst node = <div>{user.na|}</div>", 'name']
  ])('parses JSX syntax in %s', (path, source, expected) => {
    const input = marked(source)
    const { project } = projectWith({ [path]: input.text })
    const entries = project.getCompletions(path, input.offset)?.entries ?? []
    expect(entries.some((entry) => entry.name === expected)).toBe(true)
  })
})
