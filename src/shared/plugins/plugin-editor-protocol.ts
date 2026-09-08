import { Buffer } from 'node:buffer'
import { z } from 'zod'

export const PLUGIN_EDITOR_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024
export const PLUGIN_EDITOR_CHANGE_BATCH_MAX_BYTES = 256 * 1024
export const PLUGIN_EDITOR_COMPLETION_ITEM_LIMIT = 512
export const PLUGIN_EDITOR_COMPLETION_RESPONSE_MAX_BYTES = 512 * 1024
export const PLUGIN_EDITOR_DIAGNOSTIC_LIMIT = 2048
export const PLUGIN_EDITOR_DIAGNOSTICS_MAX_BYTES = 1024 * 1024
export const PLUGIN_EDITOR_MESSAGE_MAX_LENGTH = 8192
export const PLUGIN_EDITOR_TEXT_EDIT_MAX_LENGTH = 256 * 1024

const opaqueIdSchema = z.string().min(1).max(256)
const filePathSchema = z.string().min(1).max(4096)
const languageIdSchema = z.string().min(1).max(128)
const documentVersionSchema = z.number().int().positive()

function fitsByteBudget(value: unknown, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes
}

export const editorPositionSchema = z
  .object({
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative()
  })
  .strict()

export const editorRangeSchema = z
  .object({
    start: editorPositionSchema,
    end: editorPositionSchema
  })
  .strict()

const editorDocumentDescriptorSchema = z
  .object({
    documentId: opaqueIdSchema,
    worktreeId: opaqueIdSchema,
    filePath: filePathSchema,
    languageId: languageIdSchema,
    version: documentVersionSchema
  })
  .strict()

export const editorDocumentOpenSchema = editorDocumentDescriptorSchema
  .extend({ text: z.string() })
  .refine((value) => fitsByteBudget(value, PLUGIN_EDITOR_DOCUMENT_MAX_BYTES), {
    message: `editor document snapshot exceeds ${PLUGIN_EDITOR_DOCUMENT_MAX_BYTES} bytes`
  })

export const editorTextChangeSchema = z
  .object({
    range: editorRangeSchema,
    rangeLength: z.number().int().nonnegative(),
    text: z.string()
  })
  .strict()

export const editorDocumentChangeSchema = z
  .object({
    documentId: opaqueIdSchema,
    version: documentVersionSchema,
    changes: z.array(editorTextChangeSchema).min(1).max(512)
  })
  .strict()
  .refine((value) => fitsByteBudget(value, PLUGIN_EDITOR_CHANGE_BATCH_MAX_BYTES), {
    message: `editor change batch exceeds ${PLUGIN_EDITOR_CHANGE_BATCH_MAX_BYTES} bytes`
  })

export const editorDocumentCloseSchema = z
  .object({
    documentId: opaqueIdSchema,
    finalVersion: documentVersionSchema
  })
  .strict()

export const editorCompletionRequestSchema = z
  .object({
    requestId: opaqueIdSchema,
    documentId: opaqueIdSchema,
    version: documentVersionSchema,
    position: editorPositionSchema,
    context: z
      .object({
        triggerKind: z.enum(['invoked', 'triggerCharacter', 'triggerForIncompleteCompletions']),
        triggerCharacter: z.string().min(1).max(16).optional()
      })
      .strict()
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.context.triggerKind === 'triggerCharacter' && !request.context.triggerCharacter) {
      ctx.addIssue({
        code: 'custom',
        path: ['context', 'triggerCharacter'],
        message: 'required for triggerCharacter requests'
      })
    }
  })

export const EDITOR_COMPLETION_KINDS = [
  'text',
  'method',
  'function',
  'constructor',
  'field',
  'variable',
  'class',
  'interface',
  'module',
  'property',
  'unit',
  'value',
  'enum',
  'keyword',
  'snippet',
  'color',
  'file',
  'reference',
  'folder',
  'enumMember',
  'constant',
  'struct',
  'event',
  'operator',
  'typeParameter'
] as const

export const editorCompletionItemSchema = z
  .object({
    label: z.string().min(1).max(PLUGIN_EDITOR_MESSAGE_MAX_LENGTH),
    kind: z.enum(EDITOR_COMPLETION_KINDS).optional(),
    detail: z.string().max(PLUGIN_EDITOR_MESSAGE_MAX_LENGTH).optional(),
    documentation: z.string().max(PLUGIN_EDITOR_MESSAGE_MAX_LENGTH).optional(),
    sortText: z.string().max(PLUGIN_EDITOR_MESSAGE_MAX_LENGTH).optional(),
    filterText: z.string().max(PLUGIN_EDITOR_MESSAGE_MAX_LENGTH).optional(),
    insertText: z.string().max(PLUGIN_EDITOR_TEXT_EDIT_MAX_LENGTH).optional(),
    textEdit: z
      .object({
        range: editorRangeSchema,
        newText: z.string().max(PLUGIN_EDITOR_TEXT_EDIT_MAX_LENGTH)
      })
      .strict()
      .optional(),
    commitCharacters: z.array(z.string().min(1).max(16)).max(64).optional()
  })
  .strict()

export const editorCompletionListSchema = z
  .object({
    isIncomplete: z.boolean(),
    items: z.array(editorCompletionItemSchema).max(PLUGIN_EDITOR_COMPLETION_ITEM_LIMIT)
  })
  .strict()

export const editorCompletionResponseSchema = z
  .object({
    requestId: opaqueIdSchema,
    documentId: opaqueIdSchema,
    version: documentVersionSchema,
    completion: editorCompletionListSchema
  })
  .strict()
  .refine((value) => fitsByteBudget(value, PLUGIN_EDITOR_COMPLETION_RESPONSE_MAX_BYTES), {
    message: `editor completion response exceeds ${PLUGIN_EDITOR_COMPLETION_RESPONSE_MAX_BYTES} bytes`
  })

export const editorDiagnosticSchema = z
  .object({
    range: editorRangeSchema,
    severity: z.enum(['error', 'warning', 'information', 'hint']),
    message: z.string().min(1).max(PLUGIN_EDITOR_MESSAGE_MAX_LENGTH),
    code: z.string().max(256).optional(),
    source: z.string().max(256).optional()
  })
  .strict()

export const editorDiagnosticsPublicationSchema = z
  .object({
    documentId: opaqueIdSchema,
    version: documentVersionSchema,
    diagnostics: z.array(editorDiagnosticSchema).max(PLUGIN_EDITOR_DIAGNOSTIC_LIMIT)
  })
  .strict()
  .refine((value) => fitsByteBudget(value, PLUGIN_EDITOR_DIAGNOSTICS_MAX_BYTES), {
    message: `editor diagnostics publication exceeds ${PLUGIN_EDITOR_DIAGNOSTICS_MAX_BYTES} bytes`
  })

export const editorCancelRequestSchema = z.object({ requestId: opaqueIdSchema }).strict()

export type EditorPosition = z.infer<typeof editorPositionSchema>
export type EditorRange = z.infer<typeof editorRangeSchema>
export type EditorDocumentOpen = z.infer<typeof editorDocumentOpenSchema>
export type EditorTextChange = z.infer<typeof editorTextChangeSchema>
export type EditorDocumentChange = z.infer<typeof editorDocumentChangeSchema>
export type EditorDocumentClose = z.infer<typeof editorDocumentCloseSchema>
export type EditorCompletionRequest = z.infer<typeof editorCompletionRequestSchema>
export type EditorCompletionKind = (typeof EDITOR_COMPLETION_KINDS)[number]
export type EditorCompletionItem = z.infer<typeof editorCompletionItemSchema>
export type EditorCompletionList = z.infer<typeof editorCompletionListSchema>
export type EditorCompletionResponse = z.infer<typeof editorCompletionResponseSchema>
export type EditorDiagnostic = z.infer<typeof editorDiagnosticSchema>
export type EditorDiagnosticsPublication = z.infer<typeof editorDiagnosticsPublicationSchema>
export type EditorCancelRequest = z.infer<typeof editorCancelRequestSchema>
