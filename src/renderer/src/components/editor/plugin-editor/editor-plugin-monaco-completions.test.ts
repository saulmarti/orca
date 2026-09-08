import { describe, expect, it, vi } from 'vitest'
import { toMonacoCompletionItem } from './editor-plugin-monaco-completions'

describe('editor plugin Monaco completions', () => {
  it('maps protocol completion edits and kinds to Monaco', () => {
    const monaco = { languages: { CompletionItemKind: { Text: 0, Function: 1 } } } as never
    const model = { getWordUntilPosition: vi.fn(() => ({ startColumn: 2, endColumn: 5 })) } as never
    const result = toMonacoCompletionItem(monaco, model, { lineNumber: 3, column: 5 } as never, {
      label: 'fixtureCompletion',
      kind: 'function',
      detail: 'Fixture',
      insertText: 'ignored',
      textEdit: {
        range: { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } },
        newText: 'fixtureCompletion()'
      }
    })
    expect(result).toMatchObject({
      label: 'fixtureCompletion',
      kind: 1,
      detail: 'Fixture',
      insertText: 'fixtureCompletion()',
      range: { startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 5 }
    })
  })
})
