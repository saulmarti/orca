import * as ts from '@typescript/typescript6'
import type { EditorDiagnostic } from '../../../src/shared/plugins/plugin-editor-protocol'
import type { TypeScriptProject } from './typescript-project'

function severity(category: ts.DiagnosticCategory): EditorDiagnostic['severity'] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return 'error'
    case ts.DiagnosticCategory.Warning:
      return 'warning'
    case ts.DiagnosticCategory.Suggestion:
      return 'information'
    case ts.DiagnosticCategory.Message:
      return 'information'
  }
}

export function adaptDiagnostics(
  project: TypeScriptProject,
  relativePath: string,
  diagnostics: readonly ts.Diagnostic[]
): EditorDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const start = diagnostic.start ?? 0
    const end = start + (diagnostic.length ?? 0)
    return {
      range: {
        start: project.positionAt(relativePath, start),
        end: project.positionAt(relativePath, end)
      },
      severity: severity(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      code: String(diagnostic.code),
      source: 'typescript'
    }
  })
}
