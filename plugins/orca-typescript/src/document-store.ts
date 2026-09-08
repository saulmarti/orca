import type {
  EditorDocumentChange,
  EditorDocumentOpen,
  EditorPosition,
  EditorTextChange
} from '../../../src/shared/plugins/plugin-editor-protocol'

export type OpenDocument = {
  documentId: string
  worktreeId: string
  filePath: string
  relativePath: string
  languageId: string
  documentVersion: number
  scriptVersion: number
  text: string
}

function pathKey(worktreeId: string, relativePath: string): string {
  return `${worktreeId}\u0000${relativePath}`
}

function offsetAt(text: string, position: EditorPosition): number {
  if (position.line < 0 || position.character < 0) {
    throw new Error('editor position must be non-negative')
  }
  let line = 0
  let offset = 0
  while (line < position.line) {
    const newline = text.indexOf('\n', offset)
    if (newline === -1) {
      throw new Error('editor position line is outside document')
    }
    offset = newline + 1
    line += 1
  }
  const lineEnd = text.indexOf('\n', offset)
  const contentEnd = lineEnd === -1 ? text.length : lineEnd
  const candidate = offset + position.character
  if (candidate > contentEnd) {
    throw new Error('editor position character is outside line')
  }
  return candidate
}

type ResolvedChange = EditorTextChange & { startOffset: number; endOffset: number }

function resolveChanges(text: string, changes: EditorTextChange[]): ResolvedChange[] {
  return changes.map((change) => {
    const startOffset = offsetAt(text, change.range.start)
    const endOffset = offsetAt(text, change.range.end)
    if (endOffset < startOffset || endOffset - startOffset !== change.rangeLength) {
      throw new Error('editor change rangeLength does not match UTF-16 range')
    }
    return { ...change, startOffset, endOffset }
  })
}
function applyChanges(text: string, changes: EditorTextChange[]): string {
  const resolved = resolveChanges(text, changes).sort(
    (left, right) => right.startOffset - left.startOffset
  )
  let next = text
  let previousStart = text.length + 1
  for (const change of resolved) {
    if (change.endOffset > previousStart) {
      throw new Error('editor change ranges overlap')
    }
    next = `${next.slice(0, change.startOffset)}${change.text}${next.slice(change.endOffset)}`
    previousStart = change.startOffset
  }
  return next
}

export class DocumentStore {
  private readonly byId = new Map<string, OpenDocument>()
  private readonly byPath = new Map<string, OpenDocument>()

  open(document: EditorDocumentOpen): OpenDocument {
    const current = this.byId.get(document.documentId)
    if (current) {
      this.byPath.delete(pathKey(current.worktreeId, current.relativePath))
    }
    const openDocument: OpenDocument = {
      documentId: document.documentId,
      worktreeId: document.worktreeId,
      filePath: document.filePath,
      relativePath: document.relativePath,
      languageId: document.languageId,
      documentVersion: document.version,
      scriptVersion: 1,
      text: document.text
    }
    this.byId.set(openDocument.documentId, openDocument)
    this.byPath.set(pathKey(openDocument.worktreeId, openDocument.relativePath), openDocument)
    return openDocument
  }

  change(change: EditorDocumentChange): OpenDocument {
    const current = this.byId.get(change.documentId)
    if (!current) {
      throw new Error(`editor document ${change.documentId} is not open`)
    }
    if (change.version <= current.documentVersion) {
      throw new Error(`editor document version must increase from ${current.documentVersion}`)
    }
    current.text = applyChanges(current.text, change.changes)
    current.documentVersion = change.version
    current.scriptVersion += 1
    return current
  }

  close(documentId: string, finalVersion: number): OpenDocument | undefined {
    const current = this.byId.get(documentId)
    if (!current) {
      return undefined
    }
    if (finalVersion < current.documentVersion) {
      throw new Error(`editor close version ${finalVersion} is stale`)
    }
    this.byId.delete(documentId)
    this.byPath.delete(pathKey(current.worktreeId, current.relativePath))
    return current
  }

  getOpenById(documentId: string): OpenDocument | undefined {
    return this.byId.get(documentId)
  }

  getOpenByPath(worktreeId: string, relativePath: string): OpenDocument | undefined {
    return this.byPath.get(pathKey(worktreeId, relativePath))
  }

  resolveText(
    worktreeId: string,
    relativePath: string,
    readDisk: (worktreeId: string, relativePath: string) => string | undefined
  ): string | undefined {
    return this.getOpenByPath(worktreeId, relativePath)?.text ?? readDisk(worktreeId, relativePath)
  }
}
