import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { provideCompletions } from './completion-adapter'
import { summarizeCompletionBenchmark } from './completion-benchmark'
import { DocumentStore } from './document-store'
import { TypeScriptProject } from './typescript-project'
import { WorkspaceFileCache } from './workspace-file-cache'

const PROJECT_KEY = 'wt-1\u0000config:tsconfig.json'
const EXAMPLE_PATH = 'src/example.ts'
const EXAMPLE_TEXT = [
  "import type { User } from './user'",
  'declare const user: User',
  'user.na'
].join('\n')

function addFile(cache: WorkspaceFileCache, path: string, text: string): void {
  cache.setFile(PROJECT_KEY, 'wt-1', path, {
    text,
    byteLength: Buffer.byteLength(text),
    mtimeMs: 1
  })
}
function createBenchmarkProject(): TypeScriptProject {
  const cache = new WorkspaceFileCache()
  const documents = new DocumentStore()
  addFile(cache, 'src/user.ts', 'export interface User { name: string; age: number }')
  addFile(cache, EXAMPLE_PATH, EXAMPLE_TEXT)
  for (let index = 0; index < 30; index += 1) {
    addFile(
      cache,
      `src/model-${index}.ts`,
      `export interface Model${index} { id: string; value${index}: number }`
    )
  }
  return new TypeScriptProject({
    key: PROJECT_KEY,
    worktreeId: 'wt-1',
    rootRelativePath: '',
    documents,
    cache,
    rootFiles: [
      'src/user.ts',
      EXAMPLE_PATH,
      ...Array.from({ length: 30 }, (_, i) => `src/model-${i}.ts`)
    ]
  })
}
describe('warm TypeScript completion performance', () => {
  it('keeps warmed project-aware completion P95 below 100 ms', () => {
    const project = createBenchmarkProject()
    const position = { line: 2, character: 7 }

    for (let index = 0; index < 10; index += 1) {
      expect(
        provideCompletions(project, EXAMPLE_PATH, position).items.some(
          (item) => item.label === 'name'
        )
      ).toBe(true)
    }

    const samples: number[] = []
    for (let index = 0; index < 60; index += 1) {
      const startedAt = performance.now()
      const completion = provideCompletions(project, EXAMPLE_PATH, position)
      samples.push(performance.now() - startedAt)
      expect(completion.items.some((item) => item.label === 'name')).toBe(true)
    }

    const summary = summarizeCompletionBenchmark(samples, 100)
    console.info(summary.report)
    expect(summary.meetsTarget).toBe(true)
  })
})
