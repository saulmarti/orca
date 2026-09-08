import type { editor, languages, Position } from 'monaco-editor'
import type {
  EditorCompletionItem,
  EditorCompletionKind
} from '../../../../../shared/plugins/plugin-editor-protocol'
import { toMonacoRange } from './editor-plugin-position'

type MonacoCompletionApi = {
  languages: {
    CompletionItemKind: { [K in keyof typeof completionKindNames]: languages.CompletionItemKind }
  }
}

const completionKindNames = {
  Text: true,
  Method: true,
  Function: true,
  Constructor: true,
  Field: true,
  Variable: true,
  Class: true,
  Interface: true,
  Module: true,
  Property: true,
  Unit: true,
  Value: true,
  Enum: true,
  Keyword: true,
  Snippet: true,
  Color: true,
  File: true,
  Reference: true,
  Folder: true,
  EnumMember: true,
  Constant: true,
  Struct: true,
  Event: true,
  Operator: true,
  TypeParameter: true
} as const

function completionKind(
  monaco: MonacoCompletionApi,
  kind: EditorCompletionKind | undefined
): languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind
  switch (kind) {
    case undefined:
    case 'text':
      return kinds.Text
    case 'method':
      return kinds.Method
    case 'function':
      return kinds.Function
    case 'constructor':
      return kinds.Constructor
    case 'field':
      return kinds.Field
    case 'variable':
      return kinds.Variable
    case 'class':
      return kinds.Class
    case 'interface':
      return kinds.Interface
    case 'module':
      return kinds.Module
    case 'property':
      return kinds.Property
    case 'unit':
      return kinds.Unit
    case 'value':
      return kinds.Value
    case 'enum':
      return kinds.Enum
    case 'keyword':
      return kinds.Keyword
    case 'snippet':
      return kinds.Snippet
    case 'color':
      return kinds.Color
    case 'file':
      return kinds.File
    case 'reference':
      return kinds.Reference
    case 'folder':
      return kinds.Folder
    case 'enumMember':
      return kinds.EnumMember
    case 'constant':
      return kinds.Constant
    case 'struct':
      return kinds.Struct
    case 'event':
      return kinds.Event
    case 'operator':
      return kinds.Operator
    case 'typeParameter':
      return kinds.TypeParameter
  }
}

export function toMonacoCompletionItem(
  monaco: MonacoCompletionApi,
  model: editor.ITextModel,
  position: Position,
  item: EditorCompletionItem
): languages.CompletionItem {
  const fallbackWord = model.getWordUntilPosition(position)
  const range = item.textEdit
    ? toMonacoRange(item.textEdit.range)
    : {
        startLineNumber: position.lineNumber,
        startColumn: fallbackWord.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      }
  return {
    label: item.label,
    kind: completionKind(monaco, item.kind),
    detail: item.detail,
    documentation: item.documentation,
    sortText: item.sortText,
    filterText: item.filterText,
    insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
    range,
    commitCharacters: item.commitCharacters
  }
}
