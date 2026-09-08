import { describe, expect, it } from 'vitest'
import { toEditorPosition, toEditorRange, toMonacoRange } from './editor-plugin-position'

describe('editor plugin position conversion', () => {
  it('converts Monaco 1-based coordinates to protocol 0-based UTF-16 coordinates', () => {
    expect(toEditorPosition({ lineNumber: 3, column: 5 })).toEqual({ line: 2, character: 4 })
    expect(
      toEditorRange({ startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 6 })
    ).toEqual({ start: { line: 1, character: 2 }, end: { line: 3, character: 5 } })
  })

  it('converts protocol ranges back to Monaco coordinates', () => {
    expect(
      toMonacoRange({ start: { line: 1, character: 2 }, end: { line: 3, character: 5 } })
    ).toEqual({ startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 6 })
  })
})
