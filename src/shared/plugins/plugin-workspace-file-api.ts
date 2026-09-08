import { Buffer } from 'node:buffer'
import { z } from 'zod'

export const PLUGIN_WORKSPACE_FILE_BATCH_LIMIT = 256
export const PLUGIN_WORKSPACE_FILE_MAX_BYTES = 4 * 1024 * 1024
export const PLUGIN_WORKSPACE_READ_RESPONSE_MAX_BYTES = 8 * 1024 * 1024
export const PLUGIN_WORKSPACE_DIRECTORY_ENTRY_LIMIT = 2048

const worktreeIdSchema = z.string().min(1).max(256)

function workspacePathSchema(options: { allowRoot: boolean }) {
  return z
    .string()
    .max(4096)
    .refine((path) => {
      if (path === '') {
        return options.allowRoot
      }
      if (path.includes('\\') || path.startsWith('/') || /^[a-zA-Z]:\//.test(path)) {
        return false
      }
      return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    }, 'path must be normalized and relative to the worktree')
}

const filePathSchema = workspacePathSchema({ allowRoot: false })
const directoryPathSchema = workspacePathSchema({ allowRoot: true })
const byteLengthSchema = z.number().int().nonnegative()
const mtimeSchema = z.number().finite().nonnegative()
export const workspaceReadDirectoryParamsSchema = z
  .object({ worktreeId: worktreeIdSchema, path: directoryPathSchema })
  .strict()

const directoryEntrySchema = z
  .object({
    name: z.string().min(1).max(1024),
    path: filePathSchema
  })
  .strict()

export const workspaceReadDirectoryResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      path: directoryPathSchema,
      status: z.literal('ok'),
      entries: z.array(directoryEntrySchema).max(PLUGIN_WORKSPACE_DIRECTORY_ENTRY_LIMIT)
    })
    .strict(),
  z
    .object({
      path: directoryPathSchema,
      status: z.enum(['missing', 'not-directory'])
    })
    .strict()
])
const fileBatchParamsSchema = z
  .object({
    worktreeId: worktreeIdSchema,
    paths: z.array(filePathSchema).min(1).max(PLUGIN_WORKSPACE_FILE_BATCH_LIMIT)
  })
  .strict()

export const workspaceStatFilesParamsSchema = fileBatchParamsSchema

const statOkSchema = z
  .object({
    path: filePathSchema,
    status: z.literal('ok'),
    type: z.enum(['file', 'directory']),
    byteLength: byteLengthSchema,
    mtimeMs: mtimeSchema
  })
  .strict()
const statMissingSchema = z.object({ path: filePathSchema, status: z.literal('missing') }).strict()

export const workspaceStatFilesResultSchema = z
  .object({
    results: z
      .array(z.union([statOkSchema, statMissingSchema]))
      .max(PLUGIN_WORKSPACE_FILE_BATCH_LIMIT)
  })
  .strict()
export const workspaceReadFilesParamsSchema = fileBatchParamsSchema

const readOkSchema = z
  .object({
    path: filePathSchema,
    status: z.literal('ok'),
    content: z.string(),
    byteLength: byteLengthSchema,
    mtimeMs: mtimeSchema
  })
  .strict()
  .refine((value) => Buffer.byteLength(value.content, 'utf8') === value.byteLength, {
    message: 'byteLength must match UTF-8 content length'
  })
  .refine((value) => value.byteLength <= PLUGIN_WORKSPACE_FILE_MAX_BYTES, {
    message: `file content exceeds ${PLUGIN_WORKSPACE_FILE_MAX_BYTES} bytes`
  })

const readStatusSchema = z
  .object({
    path: filePathSchema,
    status: z.enum(['missing', 'not-file', 'too-large', 'binary'])
  })
  .strict()

export const workspaceReadFilesResultSchema = z
  .object({
    results: z
      .array(z.union([readOkSchema, readStatusSchema]))
      .max(PLUGIN_WORKSPACE_FILE_BATCH_LIMIT)
  })
  .strict()
  .refine(
    (value) =>
      value.results.reduce(
        (total, result) => total + (result.status === 'ok' ? result.byteLength : 0),
        0
      ) <= PLUGIN_WORKSPACE_READ_RESPONSE_MAX_BYTES,
    { message: `read response exceeds ${PLUGIN_WORKSPACE_READ_RESPONSE_MAX_BYTES} bytes` }
  )

export const PLUGIN_WORKSPACE_FILE_HOST_METHODS = [
  {
    name: 'workspace.readDirectory',
    since: '1.0',
    scope: 'active-worktree',
    stability: 'experimental',
    capability: 'workspace:readFiles',
    mutation: false,
    panel: false,
    params: workspaceReadDirectoryParamsSchema,
    result: workspaceReadDirectoryResultSchema
  },
  {
    name: 'workspace.statFiles',
    since: '1.0',
    scope: 'active-worktree',
    stability: 'experimental',
    capability: 'workspace:readFiles',
    mutation: false,
    panel: false,
    params: workspaceStatFilesParamsSchema,
    result: workspaceStatFilesResultSchema
  },
  {
    name: 'workspace.readFiles',
    since: '1.0',
    scope: 'active-worktree',
    stability: 'experimental',
    capability: 'workspace:readFiles',
    mutation: false,
    panel: false,
    params: workspaceReadFilesParamsSchema,
    result: workspaceReadFilesResultSchema
  }
] as const
