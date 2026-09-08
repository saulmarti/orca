import { describe, expect, it } from 'vitest'
import {
  PLUGIN_EDITOR_CHANGE_BATCH_MAX_BYTES,
  PLUGIN_EDITOR_COMPLETION_ITEM_LIMIT,
  PLUGIN_EDITOR_COMPLETION_RESPONSE_MAX_BYTES,
  PLUGIN_EDITOR_DIAGNOSTIC_LIMIT,
  PLUGIN_EDITOR_DIAGNOSTICS_MAX_BYTES,
  PLUGIN_EDITOR_DOCUMENT_MAX_BYTES,
  PLUGIN_EDITOR_MESSAGE_MAX_LENGTH,
  editorCancelRequestSchema,
  editorCompletionRequestSchema,
  editorCompletionResponseSchema,
  editorDiagnosticsPublicationSchema,
  editorDocumentChangeSchema,
  editorDocumentCloseSchema,
  editorDocumentOpenSchema,
  editorPositionSchema
} from './plugin-editor-protocol'

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 }
}

const completionItem = { label: 'fixtureCompletion', insertText: 'fixtureCompletion' }
const diagnostic = {
  range,
  severity: 'error',
  message: 'fixture error'
}

describe('plugin editor protocol boundaries', () => {
  it('requires a bounded workspace-relative path on document open', () => {
    const base = {
      documentId: 'doc-1',
      worktreeId: 'worktree-1',
      filePath: '/repo/src/index.ts',
      languageId: 'typescript',
      version: 1,
      text: ''
    }
    expect(editorDocumentOpenSchema.safeParse(base).success).toBe(false)
    expect(
      editorDocumentOpenSchema.safeParse({ ...base, relativePath: 'src/index.ts' }).success
    ).toBe(true)
  })

  it('uses nonnegative positions and positive document versions', () => {
    expect(editorPositionSchema.safeParse({ line: 0, character: 0 }).success).toBe(true)
    expect(editorPositionSchema.safeParse({ line: -1, character: 0 }).success).toBe(false)
    expect(
      editorDocumentOpenSchema.safeParse({
        documentId: 'doc-1',
        worktreeId: 'worktree-1',
        filePath: 'src/index.ts',
        languageId: 'typescript',
        version: 0,
        text: ''
      }).success
    ).toBe(false)
    expect(
      editorDocumentCloseSchema.safeParse({ documentId: 'doc-1', finalVersion: 1 }).success
    ).toBe(true)
  })

  it('accepts bounded incremental document changes', () => {
    expect(
      editorDocumentChangeSchema.safeParse({
        documentId: 'doc-1',
        version: 2,
        changes: [{ range, rangeLength: 1, text: 'x' }]
      }).success
    ).toBe(true)
    expect(
      editorDocumentChangeSchema.safeParse({
        documentId: 'doc-1',
        version: 2,
        changes: [{ range, rangeLength: 1, text: 'x'.repeat(PLUGIN_EDITOR_CHANGE_BATCH_MAX_BYTES) }]
      }).success
    ).toBe(false)
  })

  it('rejects oversized document snapshots', () => {
    expect(
      editorDocumentOpenSchema.safeParse({
        documentId: 'doc-1',
        worktreeId: 'worktree-1',
        filePath: 'src/index.ts',
        languageId: 'typescript',
        version: 1,
        text: 'x'.repeat(PLUGIN_EDITOR_DOCUMENT_MAX_BYTES + 1)
      }).success
    ).toBe(false)
  })

  it('validates completion requests and bounds completion responses', () => {
    expect(
      editorCompletionRequestSchema.safeParse({
        requestId: 'req-1',
        documentId: 'doc-1',
        version: 2,
        position: { line: 3, character: 4 },
        context: { triggerKind: 'invoked' }
      }).success
    ).toBe(true)

    const baseResponse = {
      requestId: 'req-1',
      documentId: 'doc-1',
      version: 2,
      completion: { isIncomplete: false, items: [completionItem] }
    }
    expect(editorCompletionResponseSchema.safeParse(baseResponse).success).toBe(true)
    expect(
      editorCompletionResponseSchema.safeParse({
        ...baseResponse,
        completion: {
          isIncomplete: false,
          items: Array.from(
            { length: PLUGIN_EDITOR_COMPLETION_ITEM_LIMIT + 1 },
            () => completionItem
          )
        }
      }).success
    ).toBe(false)
    expect(
      editorCompletionResponseSchema.safeParse({
        ...baseResponse,
        completion: {
          isIncomplete: false,
          items: [{ label: 'x', documentation: 'x'.repeat(PLUGIN_EDITOR_MESSAGE_MAX_LENGTH + 1) }]
        }
      }).success
    ).toBe(false)
    expect(
      editorCompletionResponseSchema.safeParse({
        ...baseResponse,
        completion: {
          isIncomplete: false,
          items: [
            { label: 'x', insertText: 'x'.repeat(PLUGIN_EDITOR_COMPLETION_RESPONSE_MAX_BYTES) }
          ]
        }
      }).success
    ).toBe(false)
  })

  it('bounds diagnostic count and messages', () => {
    const basePublication = {
      documentId: 'doc-1',
      version: 2,
      diagnostics: [diagnostic]
    }
    expect(editorDiagnosticsPublicationSchema.safeParse(basePublication).success).toBe(true)
    expect(
      editorDiagnosticsPublicationSchema.safeParse({
        ...basePublication,
        diagnostics: Array.from({ length: PLUGIN_EDITOR_DIAGNOSTIC_LIMIT + 1 }, () => diagnostic)
      }).success
    ).toBe(false)
    expect(
      editorDiagnosticsPublicationSchema.safeParse({
        ...basePublication,
        diagnostics: [{ ...diagnostic, message: 'x'.repeat(PLUGIN_EDITOR_MESSAGE_MAX_LENGTH + 1) }]
      }).success
    ).toBe(false)
    expect(
      editorDiagnosticsPublicationSchema.safeParse({
        ...basePublication,
        diagnostics: [{ ...diagnostic, source: 'x'.repeat(PLUGIN_EDITOR_DIAGNOSTICS_MAX_BYTES) }]
      }).success
    ).toBe(false)
  })

  it('validates cancellation by opaque request id', () => {
    expect(editorCancelRequestSchema.safeParse({ requestId: 'req-1' }).success).toBe(true)
    expect(editorCancelRequestSchema.safeParse({ requestId: '' }).success).toBe(false)
  })
})
