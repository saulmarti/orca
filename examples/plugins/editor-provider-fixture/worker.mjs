const documents = new Map()

function offsetAt(text, position) {
  const lines = text.split('\n')
  let offset = 0
  for (let line = 0; line < position.line; line += 1) {
    offset += (lines[line] ?? '').length + 1
  }
  return offset + position.character
}

function applyChanges(text, changes) {
  const edits = changes.map((change) => ({
    start: offsetAt(text, change.range.start),
    end: offsetAt(text, change.range.end),
    text: change.text
  }))
  edits.sort((left, right) => right.start - left.start)
  let next = text
  for (const edit of edits) {
    next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`
  }
  return next
}

function publish(orca, providerId, documentId, version, text) {
  const start = text.indexOf('fixture_error')
  const diagnostics =
    start === -1
      ? []
      : [
          {
            range: {
              start: { line: 0, character: start },
              end: { line: 0, character: start + 'fixture_error'.length }
            },
            severity: 'error',
            message: 'fixture error',
            source: 'editor-provider-fixture'
          }
        ]
  orca.editor.publishDiagnostics(providerId, { documentId, version, diagnostics })
}

export default function activate(orca) {
  const providerId = 'typescript'
  return orca.editor.registerProvider(providerId, {
    openDocument(document) {
      documents.set(document.documentId, { text: document.text, version: document.version })
      publish(orca, providerId, document.documentId, document.version, document.text)
    },
    changeDocument(change) {
      const current = documents.get(change.documentId)
      if (!current) {
        return
      }
      current.text = applyChanges(current.text, change.changes)
      current.version = change.version
      publish(orca, providerId, change.documentId, change.version, current.text)
    },
    closeDocument(document) {
      documents.delete(document.documentId)
    },
    provideCompletions() {
      return {
        isIncomplete: false,
        items: [{ label: 'fixtureCompletion', insertText: 'fixtureCompletion' }]
      }
    }
  })
}
