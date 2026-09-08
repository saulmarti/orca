import { ipcMain, type WebContents } from 'electron'
import {
  editorCancelRequestSchema,
  editorCompletionRequestSchema,
  editorDocumentChangeSchema,
  editorDocumentCloseSchema,
  editorDocumentOpenSchema
} from '../../shared/plugins/plugin-editor-protocol'
import type { PluginService } from '../plugins/plugin-service'

function rendererOwner(sender: Pick<WebContents, 'id'>): string {
  return `renderer:${sender.id}`
}

export function registerPluginEditorHandlers(pluginService: PluginService): void {
  const senders = new Map<string, WebContents>()

  function bindSender(sender: WebContents): string {
    const ownerKey = rendererOwner(sender)
    if (!senders.has(ownerKey)) {
      senders.set(ownerKey, sender)
      let finished = false
      const cleanup = (): void => {
        if (finished) {
          return
        }
        finished = true
        sender.removeListener('destroyed', cleanup)
        sender.removeListener('render-process-gone', cleanup)
        senders.delete(ownerKey)
        pluginService.editor.revokeOwner(ownerKey)
      }
      sender.once('destroyed', cleanup)
      sender.once('render-process-gone', cleanup)
    }
    return ownerKey
  }

  pluginService.onEditorDiagnostics((event) => {
    senders.get(event.ownerKey)?.send('plugins:editorDiagnostics', event)
  })

  ipcMain.handle('plugins:editorOpen', async (event, args: unknown) => {
    await pluginService.whenReady()
    const document = editorDocumentOpenSchema.parse(args)
    return pluginService.editor.open(bindSender(event.sender), document)
  })
  ipcMain.handle('plugins:editorChange', async (event, args: unknown) => {
    await pluginService.whenReady()
    pluginService.editor.change(rendererOwner(event.sender), editorDocumentChangeSchema.parse(args))
  })
  ipcMain.handle('plugins:editorClose', async (event, args: unknown) => {
    await pluginService.whenReady()
    const close = editorDocumentCloseSchema.parse(args)
    pluginService.editor.close(rendererOwner(event.sender), close.documentId, close.finalVersion)
  })
  ipcMain.handle('plugins:editorComplete', async (event, args: unknown) => {
    await pluginService.whenReady()
    return pluginService.editor.complete(
      rendererOwner(event.sender),
      editorCompletionRequestSchema.parse(args)
    )
  })
  ipcMain.handle('plugins:editorCancel', async (event, args: unknown) => {
    await pluginService.whenReady()
    const cancel = editorCancelRequestSchema.parse(args)
    pluginService.editor.cancel(rendererOwner(event.sender), cancel.requestId)
  })
}
