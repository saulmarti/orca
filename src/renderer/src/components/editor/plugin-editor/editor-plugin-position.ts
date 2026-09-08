import type {
  EditorPosition,
  EditorRange
} from '../../../../../shared/plugins/plugin-editor-protocol'

type MonacoPosition = { lineNumber: number; column: number }
type MonacoRange = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export function toEditorPosition(position: MonacoPosition): EditorPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

export function toEditorRange(range: MonacoRange): EditorRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
  }
}

export function toMonacoRange(range: EditorRange): MonacoRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}
