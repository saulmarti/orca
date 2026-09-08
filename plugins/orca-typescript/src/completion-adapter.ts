import * as ts from '@typescript/typescript6'
import {
  PLUGIN_EDITOR_COMPLETION_ITEM_LIMIT,
  type EditorCompletionItem,
  type EditorCompletionKind,
  type EditorCompletionList,
  type EditorPosition
} from '../../../src/shared/plugins/plugin-editor-protocol'
import type { TypeScriptProject } from './typescript-project'

function completionKind(kind: ts.ScriptElementKind): EditorCompletionKind | undefined {
  switch (kind) {
    case ts.ScriptElementKind.memberFunctionElement:
      return 'method'
    case ts.ScriptElementKind.functionElement:
      return 'function'
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
      return 'property'
    case ts.ScriptElementKind.variableElement:
    case ts.ScriptElementKind.letElement:
      return 'variable'
    case ts.ScriptElementKind.constElement:
      return 'constant'
    case ts.ScriptElementKind.classElement:
      return 'class'
    case ts.ScriptElementKind.interfaceElement:
      return 'interface'
    case ts.ScriptElementKind.moduleElement:
    case ts.ScriptElementKind.externalModuleName:
      return 'module'
    case ts.ScriptElementKind.enumElement:
      return 'enum'
    case ts.ScriptElementKind.enumMemberElement:
      return 'enumMember'
    case ts.ScriptElementKind.keyword:
      return 'keyword'
    case ts.ScriptElementKind.typeParameterElement:
      return 'typeParameter'
    default:
      return undefined
  }
}

export function adaptCompletionEntry(
  project: TypeScriptProject,
  relativePath: string,
  entry: ts.CompletionEntry
): EditorCompletionItem {
  const insertText = entry.insertText ?? entry.name
  const item: EditorCompletionItem = {
    label: entry.name,
    sortText: entry.sortText,
    ...(completionKind(entry.kind) ? { kind: completionKind(entry.kind) } : {}),
    ...(entry.filterText ? { filterText: entry.filterText } : {}),
    ...(entry.insertText ? { insertText: entry.insertText } : {}),
    ...(entry.source ? { detail: `Auto import from ${entry.source}` } : {})
  }
  if (entry.replacementSpan) {
    item.textEdit = {
      range: {
        start: project.positionAt(relativePath, entry.replacementSpan.start),
        end: project.positionAt(
          relativePath,
          entry.replacementSpan.start + entry.replacementSpan.length
        )
      },
      newText: insertText
    }
  }
  if (entry.commitCharacters) {
    item.commitCharacters = entry.commitCharacters
  }
  return item
}

function completionPrefix(
  project: TypeScriptProject,
  relativePath: string,
  offset: number
): string {
  const text = project.getText(relativePath) ?? ''
  return text.slice(0, offset).match(/[$_\p{ID_Continue}]+$/u)?.[0] ?? ''
}

function selectCompletionEntries(
  entries: readonly ts.CompletionEntry[],
  prefix: string
): ts.CompletionEntry[] {
  if (!prefix) {
    return entries.slice(0, PLUGIN_EDITOR_COMPLETION_ITEM_LIMIT)
  }
  const normalizedPrefix = prefix.toLocaleLowerCase()
  const preferred = entries.filter((entry) =>
    (entry.filterText ?? entry.name).toLocaleLowerCase().startsWith(normalizedPrefix)
  )
  const selected = new Set(preferred)
  for (const entry of entries) {
    if (selected.size >= PLUGIN_EDITOR_COMPLETION_ITEM_LIMIT) {
      break
    }
    selected.add(entry)
  }
  return [...selected].slice(0, PLUGIN_EDITOR_COMPLETION_ITEM_LIMIT)
}

export function provideCompletions(
  project: TypeScriptProject,
  relativePath: string,
  position: EditorPosition
): EditorCompletionList {
  const offset = project.offsetAt(relativePath, position)
  const completion = project.getCompletions(relativePath, offset)
  if (!completion) {
    return { isIncomplete: false, items: [] }
  }
  const entries = selectCompletionEntries(
    completion.entries,
    completionPrefix(project, relativePath, offset)
  )
  return {
    isIncomplete: completion.isIncomplete ?? false,
    items: entries.map((entry) => adaptCompletionEntry(project, relativePath, entry))
  }
}
