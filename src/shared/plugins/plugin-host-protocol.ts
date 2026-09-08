import { z } from 'zod'
import { PLUGIN_EDITOR_PROVIDER_LIMIT } from './plugin-editor-contributions'
import {
  editorCancelRequestSchema,
  editorCompletionRequestSchema,
  editorCompletionResponseSchema,
  editorDiagnosticsPublicationSchema,
  editorDocumentChangeSchema,
  editorDocumentCloseSchema,
  editorDocumentOpenSchema
} from './plugin-editor-protocol'
import { PLUGIN_COMMAND_LIMIT, PLUGIN_EVENT_NAMES, pluginCommandIdSchema } from './plugin-manifest'
import { pluginIdSchema } from './plugin-manifest-fields'
import { PLUGIN_CAPABILITY_KINDS } from './plugin-capabilities'

/**
 * Message protocol between the Orca process and the out-of-process plugin
 * worker (child_process.fork channel). Zod-validated on both sides because
 * the child runs third-party code — nothing it sends is trusted structurally.
 */

export const pluginWorkerInitSchema = z.object({
  type: z.literal('init'),
  /** Qualified `<publisher>.<id>` key. */
  pluginId: z.string().min(1),
  pluginRoot: z.string().min(1),
  mainEntry: z.string().min(1),
  /** Consented capability kinds, so the in-worker SDK can fail fast client-
   *  side; the host re-gates every call regardless. */
  grantedCapabilities: z.array(z.enum(PLUGIN_CAPABILITY_KINDS))
})

export const pluginWorkerInvokeCommandSchema = z.object({
  type: z.literal('invokeCommand'),
  callId: z.number().int().nonnegative(),
  commandId: z.string().min(1),
  args: z.unknown().optional()
})

export const pluginWorkerDeliverEventSchema = z.object({
  type: z.literal('deliverEvent'),
  eventId: z.number().int().nonnegative(),
  event: z.enum(PLUGIN_EVENT_NAMES),
  payload: z.unknown()
})

export const pluginWorkerHostResultSchema = z.object({
  type: z.literal('hostResult'),
  callId: z.number().int().nonnegative(),
  ok: z.boolean(),
  value: z.unknown().optional(),
  errorCode: z.string().optional(),
  error: z.string().optional()
})

export const pluginWorkerEditorDocumentOpenSchema = z.object({
  type: z.literal('editorDocumentOpen'),
  providerId: pluginIdSchema,
  document: editorDocumentOpenSchema
})

export const pluginWorkerEditorDocumentChangeSchema = z.object({
  type: z.literal('editorDocumentChange'),
  providerId: pluginIdSchema,
  change: editorDocumentChangeSchema
})

export const pluginWorkerEditorDocumentCloseSchema = z.object({
  type: z.literal('editorDocumentClose'),
  providerId: pluginIdSchema,
  document: editorDocumentCloseSchema
})

export const pluginWorkerEditorCompletionRequestSchema = z.object({
  type: z.literal('editorCompletionRequest'),
  providerId: pluginIdSchema,
  request: editorCompletionRequestSchema
})

export const pluginWorkerEditorCancelRequestSchema = editorCancelRequestSchema.extend({
  type: z.literal('editorCancelRequest')
})

export const pluginWorkerShutdownSchema = z.object({ type: z.literal('shutdown') })

export const pluginWorkerParentMessageSchema = z.discriminatedUnion('type', [
  pluginWorkerInitSchema,
  pluginWorkerInvokeCommandSchema,
  pluginWorkerDeliverEventSchema,
  pluginWorkerHostResultSchema,
  pluginWorkerEditorDocumentOpenSchema,
  pluginWorkerEditorDocumentChangeSchema,
  pluginWorkerEditorDocumentCloseSchema,
  pluginWorkerEditorCompletionRequestSchema,
  pluginWorkerEditorCancelRequestSchema,
  pluginWorkerShutdownSchema
])

export const pluginWorkerReadySchema = z.object({
  type: z.literal('ready'),
  /** Command ids the worker registered handlers for (⊆ manifest commands). */
  commands: z.array(pluginCommandIdSchema).max(PLUGIN_COMMAND_LIMIT),
  /** Editor provider ids registered by the worker (⊆ manifest providers). */
  editorProviders: z.array(pluginIdSchema).max(PLUGIN_EDITOR_PROVIDER_LIMIT).default([])
})

export const pluginWorkerCommandResultSchema = z.object({
  type: z.literal('commandResult'),
  callId: z.number().int().nonnegative(),
  ok: z.boolean(),
  // Why: value crosses a fork() IPC boundary, so it is structured-clone data
  // by construction; zod treats it as opaque and callers re-validate shape.
  value: z.unknown().optional(),
  error: z.string().max(8192).optional()
})

export const pluginWorkerEventAckSchema = z.object({
  type: z.literal('eventAck'),
  eventId: z.number().int().nonnegative()
})

/** Worker→host API call (the plugin SDK's transport for host methods). */
export const pluginWorkerHostCallSchema = z.object({
  type: z.literal('hostCall'),
  callId: z.number().int().nonnegative(),
  method: z.string().min(1),
  params: z.unknown().optional()
})

export const pluginWorkerEditorCompletionResultSchema = z
  .object({
    type: z.literal('editorCompletionResult'),
    providerId: pluginIdSchema,
    requestId: z.string().min(1).max(256),
    ok: z.boolean(),
    response: editorCompletionResponseSchema.optional(),
    error: z.string().max(8192).optional()
  })
  .superRefine((message, ctx) => {
    if (message.ok && !message.response) {
      ctx.addIssue({
        code: 'custom',
        path: ['response'],
        message: 'required for successful result'
      })
    }
    if (!message.ok && !message.error) {
      ctx.addIssue({ code: 'custom', path: ['error'], message: 'required for failed result' })
    }
    if (message.response && message.response.requestId !== message.requestId) {
      ctx.addIssue({
        code: 'custom',
        path: ['response', 'requestId'],
        message: 'must match requestId'
      })
    }
  })

export const pluginWorkerEditorDiagnosticsSchema = z.object({
  type: z.literal('editorDiagnostics'),
  providerId: pluginIdSchema,
  publication: editorDiagnosticsPublicationSchema
})

export const pluginWorkerLogSchema = z.object({
  type: z.literal('log'),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string().max(8192)
})

export const pluginWorkerFatalSchema = z.object({
  type: z.literal('fatal'),
  error: z.string().max(8192)
})

export const pluginWorkerChildMessageSchema = z.discriminatedUnion('type', [
  pluginWorkerReadySchema,
  pluginWorkerCommandResultSchema,
  pluginWorkerEventAckSchema,
  pluginWorkerHostCallSchema,
  pluginWorkerEditorCompletionResultSchema,
  pluginWorkerEditorDiagnosticsSchema,
  pluginWorkerLogSchema,
  pluginWorkerFatalSchema
])

export type PluginWorkerParentMessage = z.infer<typeof pluginWorkerParentMessageSchema>
export type PluginWorkerChildMessage = z.infer<typeof pluginWorkerChildMessageSchema>
export type PluginWorkerInit = z.infer<typeof pluginWorkerInitSchema>

export const PLUGIN_WORKER_READY_TIMEOUT_MS = 10_000
export const PLUGIN_WORKER_INVOKE_TIMEOUT_MS = 30_000
/** Idle reap: a worker with no in-flight work for this long is disposed and
 *  re-forked on the next trigger. */
export const PLUGIN_WORKER_IDLE_REAP_MS = 5 * 60_000
/** Default cap on concurrently-active workers; excess activations queue. */
export const PLUGIN_WORKER_MAX_ACTIVE_DEFAULT = 5
