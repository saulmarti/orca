import { describe, expect, it, vi } from 'vitest'
import {
  applyEditorPluginDiagnostics,
  editorPluginMarkerOwner
} from './editor-plugin-monaco-diagnostics'

describe('editor plugin Monaco diagnostics', () => {
  it('isolates marker owners and ignores stale publications', () => {
    const setModelMarkers = vi.fn()
    const monaco = {
      editor: { setModelMarkers },
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 }
    } as never
    const model = {} as never
    const event = {
      ownerKey: 'renderer:1',
      pluginKey: 'acme.tools',
      providerId: 'typescript',
      features: ['diagnostics'] as const,
      publication: {
        documentId: 'doc-1',
        version: 2,
        diagnostics: [
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
            severity: 'error' as const,
            message: 'fixture error',
            source: 'fixture'
          }
        ]
      }
    }
    expect(editorPluginMarkerOwner('acme.tools', 'typescript')).toBe('plugin:acme.tools:typescript')
    expect(applyEditorPluginDiagnostics(monaco, model, event, 'doc-1', 1)).toBe(false)
    expect(setModelMarkers).not.toHaveBeenCalled()
    expect(applyEditorPluginDiagnostics(monaco, model, event, 'doc-1', 2)).toBe(true)
    expect(setModelMarkers).toHaveBeenCalledWith(model, 'plugin:acme.tools:typescript', [
      expect.objectContaining({
        startLineNumber: 1,
        startColumn: 2,
        endLineNumber: 1,
        endColumn: 5,
        severity: 8
      })
    ])
  })
})
