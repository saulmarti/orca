import { isAbsolute, posix, relative, sep } from 'node:path'
import type { EditorPosition } from '../../../src/shared/plugins/plugin-editor-protocol'

export const VIRTUAL_ROOT = '/__orca__'

export function virtualFileName(relativePath: string): string {
  return posix.join(VIRTUAL_ROOT, relativePath.replace(/\\/g, '/'))
}

export function relativeFromVirtual(fileName: string): string | null {
  const normalized = fileName.replace(/\\/g, '/')
  const prefix = `${VIRTUAL_ROOT}/`
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null
}

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function positionAt(text: string, offset: number): EditorPosition {
  if (offset < 0 || offset > text.length) {
    throw new Error('completion offset outside document')
  }
  let line = 0
  let lineStart = 0
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, character: offset - lineStart }
}
