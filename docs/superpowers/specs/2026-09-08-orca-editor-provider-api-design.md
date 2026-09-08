# Orca Editor Provider API Design

**Date:** 2026-09-08
**Status:** Approved architecture, pending written-spec review
**Target:** `stablyai/orca`
**Scope:** Plugin-facing editor language-service bridge for real-time completions and diagnostics.

## 1. Goal

Allow Orca plugins to provide IDE-grade language intelligence to the built-in Monaco source editor without exposing Monaco itself to third-party plugins and without embedding language servers into Orca core.

The MVP provides:

- document open/change/close synchronization;
- incremental document updates;
- completion requests;
- diagnostics publication;
- request cancellation;
- deterministic cleanup when documents, providers, workers, or plugins disappear;
- explicit capability gating and resource bounds.

The MVP does **not** provide hover, go-to-definition, references, rename, code actions, formatting, signature help, semantic tokens, inlay hints, language-server process spawning, or an LSP implementation in Orca core.

## 2. Context and constraints

Orca's plugin system intentionally uses a narrow, versioned host facade. Plugin manifests are strict, capabilities are closed and explicit, and plugin workers execute out-of-process in plain Node. Third-party code therefore does not run inside the renderer and cannot currently access Monaco.

The built-in source editor already has a natural lifecycle seam in `use-monaco-editor-mount.ts`: Orca receives both the editor instance and Monaco module when a source editor mounts, installs editor-specific behavior, and disposes it when the editor instance is destroyed.

Orca also deliberately disables Monaco TypeScript/JavaScript semantic, suggestion, and syntax diagnostics. That behavior must remain unchanged. The existing Monaco worker is not project-aware enough to resolve real repository imports reliably; plugin-provided language services should add project-aware intelligence without re-enabling those built-in diagnostics.

The design must preserve:

- plugin process isolation;
- explicit capability consent;
- local, SSH, folder-workspace, and paired-runtime ownership semantics;
- deterministic lifecycle cleanup;
- existing Monaco behavior when no editor provider is installed;
- compatibility with future provider types that are not LSP-based.

## 3. Chosen architecture

Use a neutral **Editor Provider API**.

```text
Monaco source editor
        │
        ▼
Renderer EditorPluginBridge
        │
        │ versioned typed editor protocol
        ▼
Main Plugin Editor Router
        │
        ▼
Out-of-process plugin worker
        │
        ▼
Provider implementation
        │
        ├── LSP adapter
        ├── linter
        ├── AI completion engine
        └── other language tooling
```

Monaco remains an Orca implementation detail. Plugins receive normalized editor protocol values only.

### Rejected alternatives

#### Expose Monaco directly

Rejected because it would require trusted third-party renderer execution or a renderer extension host, break current isolation, and permanently couple plugin compatibility to Monaco APIs.

#### Put LSP lifecycle in Orca core

Rejected for the MVP because it turns a generic editor bridge into a language-server framework, introduces process management and per-language policy into core, and substantially increases upstream review surface.

## 4. Plugin manifest contribution

Add `contributes.editorProviders`.

Example:

```json
{
  "contributes": {
    "editorProviders": [
      {
        "id": "lsp",
        "languages": [
          "typescript",
          "javascript",
          "typescriptreact",
          "javascriptreact"
        ],
        "features": ["completion", "diagnostics"]
      }
    ]
  }
}
```

### Schema

Conceptually:

```ts
type PluginEditorProviderContribution = {
  id: string
  languages: string[]
  features: Array<'completion' | 'diagnostics'>
}
```

Constraints:

- provider id uses Orca's safe plugin-local id conventions;
- at least one language;
- languages are bounded strings and deduplicated;
- at least one feature;
- features are a closed enum in plugin API v1;
- contribution count, language count, and total string sizes are bounded;
- a provider contribution requires a plugin worker entry (`main`);
- duplicate provider ids inside one plugin are rejected;
- provider identity is canonicalized as `<qualified-plugin-key>/<provider-id>`.

The manifest contribution is declarative. It lets Orca know which providers may serve a document without eagerly starting every plugin worker.

## 5. Capability model

Add one MVP capability:

```json
{ "kind": "editor:languageService" }
```

Consent copy should state that the plugin can read source text while the user edits and return editor suggestions and diagnostics.

This capability gates:

- document text synchronization;
- completion requests;
- diagnostics publication.

The MVP intentionally does not split metadata and source-text consent because every useful completion/diagnostics provider needs the current unsaved document contents. More granular capabilities can be added later if a distinct read-only source-location use case justifies them.

## 6. Public editor protocol

The protocol is transport-neutral and does not expose Monaco types.

### 6.1 Position encoding

All protocol positions are:

- zero-based line;
- zero-based UTF-16 code-unit character offset.

This matches LSP's common position encoding and JavaScript string indexing semantics.

```ts
type EditorPosition = {
  line: number
  character: number
}

type EditorRange = {
  start: EditorPosition
  end: EditorPosition
}
```

Monaco's one-based positions are converted only at the renderer boundary.

### 6.2 Document identity

```ts
type EditorDocumentDescriptor = {
  documentId: string
  worktreeId: string
  filePath: string
  languageId: string
  version: number
}
```

Rules:

- `documentId` is opaque and unique for the live document session;
- `filePath` is normalized relative to or scoped by its owning worktree according to Orca's existing path ownership rules;
- a document id is never reused across close/reopen;
- versions start at `1` and monotonically increase;
- requests and diagnostics always include the document version they target.

### 6.3 Open

```ts
type EditorDocumentOpen = EditorDocumentDescriptor & {
  text: string
}
```

Sent exactly once to each matching active provider before changes or requests for the document.

### 6.4 Incremental change

```ts
type EditorDocumentChange = {
  documentId: string
  version: number
  changes: EditorTextChange[]
}

type EditorTextChange = {
  range: EditorRange
  rangeLength: number
  text: string
}
```

Rules:

- changes use the pre-change document coordinates of the corresponding Monaco content-change event;
- the resulting document version is carried in `version`;
- Orca preserves Monaco's change order;
- the full file is not resent per keystroke;
- a provider that loses synchronization must be able to request/resume from a fresh open snapshot through provider restart/rebind rather than accepting ambiguous deltas.

### 6.5 Close

```ts
type EditorDocumentClose = {
  documentId: string
  finalVersion: number
}
```

Close retires all pending provider requests and clears all diagnostics owned by that provider/document pair.

## 7. Completion contract

### Request

```ts
type EditorCompletionRequest = {
  requestId: string
  documentId: string
  version: number
  position: EditorPosition
  context: {
    triggerKind: 'invoked' | 'triggerCharacter' | 'triggerForIncompleteCompletions'
    triggerCharacter?: string
  }
}
```

### Response

```ts
type EditorCompletionList = {
  isIncomplete: boolean
  items: EditorCompletionItem[]
}

type EditorCompletionItem = {
  label: string
  kind?: EditorCompletionKind
  detail?: string
  documentation?: string
  sortText?: string
  filterText?: string
  insertText?: string
  textEdit?: {
    range: EditorRange
    newText: string
  }
  commitCharacters?: string[]
}
```

MVP completion kinds are a finite Orca enum mapped to/from Monaco. Unknown provider kinds degrade to a generic text item.

Resource limits apply to:

- maximum items per response;
- label/detail/documentation lengths;
- aggregate response bytes;
- commit-character count.

Orca drops a completion response when:

- request id is no longer active;
- document is closed;
- provider is disabled/replaced;
- response version does not equal the current document version;
- response fails schema validation;
- request was cancelled.

## 8. Cancellation

Completion must be cancellable.

Renderer assigns every provider request a unique `requestId`. When Monaco cancels the request token, the renderer sends a cancellation message through the editor router.

Plugin worker API receives an abort signal:

```ts
provideCompletions(
  request: EditorCompletionRequest,
  signal: AbortSignal
): Promise<EditorCompletionList>
```

If the underlying provider cannot cancel work, its eventual result is still discarded host-side.

Cancellation is not represented through the existing generic plugin event system.

## 9. Diagnostics contract

Diagnostics are push-based from the plugin worker toward the editor router.

```ts
type EditorDiagnosticsPublication = {
  documentId: string
  version: number
  diagnostics: EditorDiagnostic[]
}

type EditorDiagnostic = {
  range: EditorRange
  severity: 'error' | 'warning' | 'information' | 'hint'
  message: string
  code?: string
  source?: string
}
```

Rules:

- diagnostics require `editor:languageService`;
- document id must currently be open for that provider;
- publication version must match the current synchronized document version or is discarded;
- diagnostic count and message sizes are bounded;
- each provider owns an independent marker namespace;
- empty diagnostics explicitly clear that provider's markers;
- close, disable, uninstall, worker exit, provider reconciliation, or document rebind clears markers automatically.

Renderer marker owner:

```ts
`plugin:${pluginKey}:${providerId}`
```

No provider can overwrite another provider's markers or Orca-owned markers.

## 10. Plugin worker API

Extend the API handed to `activate(orca)` with an `editor` namespace.

```ts
type PluginWorkerOrcaApi = {
  commands: ...
  events: ...
  host: ...
  editor: {
    registerProvider(
      providerId: string,
      provider: PluginEditorProvider
    ): PluginDisposable
    publishDiagnostics(providerId: string, publication: EditorDiagnosticsPublication): void
  }
  grantedCapabilities: readonly string[]
  log(message: string): void
}
```

Provider interface:

```ts
type PluginEditorProvider = {
  openDocument?(document: EditorDocumentOpen): void | Promise<void>
  changeDocument?(change: EditorDocumentChange): void | Promise<void>
  closeDocument?(document: EditorDocumentClose): void | Promise<void>
  provideCompletions?(
    request: EditorCompletionRequest,
    signal: AbortSignal
  ): EditorCompletionList | Promise<EditorCompletionList>
}
```

Registration rules:

- provider id must be declared in `contributes.editorProviders`;
- registered features must not exceed manifest-declared features;
- only one live registration per provider id;
- activation completes only after declared provider registrations are validated;
- missing required registration makes that provider unavailable and produces a plugin error, not an Orca renderer failure;
- returned disposable unregisters the provider and triggers cleanup.

## 11. Transport and routing

Do not reuse plugin commands or generic domain events for the editor hot path.

Add a dedicated editor protocol across renderer ↔ main ↔ worker.

Conceptual message families:

```text
renderer → main
  editor.document.open
  editor.document.change
  editor.document.close
  editor.request
  editor.cancel

main → worker
  editor.document.open
  editor.document.change
  editor.document.close
  editor.request
  editor.cancel

worker → main
  editor.request.result
  editor.diagnostics

main → renderer
  editor.request.result
  editor.diagnostics
  editor.provider.changed
```

Implementation may multiplex these families over fewer IPC channel names, but schemas and lifecycle semantics remain distinct.

### Main router responsibilities

The main-process plugin editor router is the authority for:

- matching documents to declarative provider contributions;
- starting provider workers lazily;
- capability checks;
- tracking document/provider synchronization;
- routing request/cancel/result messages;
- rejecting stale or malformed messages;
- bounding pending requests and document sync traffic;
- cleanup on worker/plugin lifecycle changes;
- preserving worktree ownership.

The renderer is never the security authority for plugin identity or capability enforcement.

## 12. Renderer bridge

Create a focused renderer module responsible for adapting Monaco to the neutral protocol.

Suggested responsibility split:

```text
src/renderer/src/components/editor/plugin-editor/
  editor-plugin-bridge.ts
  editor-plugin-monaco-completions.ts
  editor-plugin-monaco-diagnostics.ts
  editor-plugin-position.ts
```

`use-monaco-editor-mount.ts` should only attach and dispose the bridge; provider protocol logic must not be embedded directly into the already busy mount hook.

Conceptual integration:

```ts
const editorPluginBridge = attachEditorPluginBridge({
  editorInstance,
  monaco,
  filePath,
  worktreeId,
  languageId
})

editorInstance.onDidDispose(() => {
  editorPluginBridge.dispose()
})
```

The bridge:

1. opens the document with its current in-memory text;
2. subscribes to Monaco content changes;
3. converts Monaco ranges to protocol positions;
4. increments/synchronizes versions;
5. registers one completion adapter per needed language/provider routing surface;
6. converts valid completion results back to Monaco items;
7. receives diagnostics and sets version-checked markers;
8. cancels pending requests on Monaco cancellation/dispose;
9. closes the document during disposal.

## 13. Multiple providers and routing policy

MVP routing policy:

- all matching diagnostics providers may publish diagnostics;
- completion uses one deterministic provider per document/language.

Completion provider precedence:

1. enabled matching provider with highest manifest `priority`, if priority is introduced in the final schema;
2. otherwise deterministic plugin-key/provider-id lexical order.

To avoid adding unnecessary policy in the MVP, the preferred initial schema omits `priority` and uses deterministic lexical ordering. A future user-facing provider preference can be additive.

Orca must never race multiple completion providers and merge arbitrary results in the first version.

## 14. Resource and performance limits

The editor path is latency-sensitive and receives untrusted plugin output.

Required bounds:

- maximum synchronized document bytes;
- maximum number of concurrently open documents per plugin;
- maximum incremental change batch bytes;
- maximum pending completion requests per plugin;
- maximum completion response bytes/items;
- maximum diagnostics count/bytes;
- timeout for completion requests;
- bounded worker/editor message queues.

Behavior when a source file exceeds the provider document-size limit:

- Orca does not synchronize that document to third-party editor providers;
- editor remains fully usable without plugin language intelligence;
- no partial/truncated document is sent.

Changes are sent incrementally and should not debounce normal typing purely for transport efficiency. Backpressure/coalescing may combine consecutive unsent change batches only if version ordering and resulting text are provably preserved.

## 15. Failure handling

### Provider worker crashes

- pending requests fail closed;
- provider diagnostics are cleared;
- synchronized document state for that provider is retired;
- editor continues functioning normally;
- provider may restart under Orca's existing worker supervision;
- on restart, live matching documents are reopened with fresh full snapshots before new requests.

### Invalid completion result

- reject result;
- log bounded plugin error;
- do not crash renderer;
- do not display partial unvalidated items.

### Invalid diagnostics

- reject publication atomically;
- preserve no stale publication from the rejected version;
- log bounded plugin error.

### Renderer reload

Main retires renderer-scoped live document sessions and pending requests. Fresh renderer mounts create new document ids and open snapshots.

### Focus/tab switching

Provider synchronization is tied to mounted live documents, not merely keyboard focus. A document may remain synchronized while its mounted editor remains alive. Disposal is the hard close boundary.

## 16. Security

The feature must preserve Orca's current plugin trust model.

Security invariants:

- no Monaco object crosses the plugin boundary;
- no renderer DOM access is granted;
- no arbitrary renderer JavaScript is executed by plugins;
- all plugin-to-host payloads are schema-validated;
- all source-text access requires explicit capability consent;
- document/worktree identity is host-bound, not plugin-supplied authority;
- plugin responses cannot write arbitrary files or execute commands through this API;
- diagnostics and completions only affect the currently authorized editor presentation;
- process spawning is explicitly outside this spec.

## 17. Remote and workspace ownership

Editor language-service documents represent the source text shown by the desktop renderer but retain the owning Orca worktree identity.

The editor router must use Orca's canonical worktree/execution-host identity rather than infer ownership from absolute paths.

For local/folder/WSL/SSH/paired runtime workspaces:

- the provider receives normalized document metadata sufficient to identify the workspace;
- this editor API does not itself grant arbitrary remote filesystem reads;
- an eventual LSP plugin must obtain any additional project/filesystem/process permissions through separate plugin capabilities;
- source changes synchronized from Monaco remain authoritative for the open unsaved document.

## 18. LSP plugin boundary

`orca-lsp` is a separate project/change from the Editor Provider API.

The core Editor Provider API does not:

- spawn language servers;
- discover language-server binaries;
- implement JSON-RPC/LSP;
- own per-language configuration;
- install language servers.

A future `orca-lsp` plugin can translate:

```text
EditorDocumentOpen    → textDocument/didOpen
EditorDocumentChange  → textDocument/didChange
EditorDocumentClose   → textDocument/didClose
CompletionRequest     → textDocument/completion
LSP diagnostics       → publishDiagnostics(providerId, publication)
```

Language-server process execution will require a separately designed capability such as a scoped `process:exec`; it must not be smuggled into `editor:languageService`.

## 19. Expected core files

Exact paths should be verified against the implementation head, but the design expects focused changes around:

```text
src/shared/plugins/
  plugin-manifest.ts
  plugin-capabilities.ts
  plugin-host-protocol.ts
  plugin-editor-protocol.ts            # new
  plugin-editor-contributions.ts        # new

src/main/plugins/
  plugin-host-runtime.ts
  plugin-host-process.ts
  plugin-worker-manager.ts
  plugin-editor-router.ts               # new
  plugin-editor-router.test.ts          # new

src/main/ipc/
  plugins.ts

src/preload/api/
  plugins-bridge.ts

src/preload/
  api-types.ts or current equivalent

src/renderer/src/components/editor/
  use-monaco-editor-mount.ts

src/renderer/src/components/editor/plugin-editor/
  editor-plugin-bridge.ts               # new
  editor-plugin-position.ts             # new
  editor-plugin-monaco-completions.ts   # new
  editor-plugin-monaco-diagnostics.ts   # new
  *.test.ts                              # new/focused tests
```

Existing plugin conformance, manifest, capability, worker-runtime, preload, and IPC tests must be extended rather than bypassed.

## 20. Test strategy

Implementation is TDD.

### Shared schema tests

Prove:

- valid `editorProviders` contribution parses;
- invalid/duplicate ids fail;
- invalid feature names fail;
- contribution/resource limits fail closed;
- `editor:languageService` capability canonicalization/consent works;
- editor protocol position, change, completion, diagnostic, and cancellation schemas reject malformed/oversized data.

### Worker runtime tests

Prove:

- provider registration is restricted to declared providers;
- open/change/close calls arrive in order;
- completion handler results return by request id;
- cancellation aborts the provider signal;
- diagnostics publication emits the correct child message;
- deactivate disposes registrations and pending requests.

### Main router tests

Prove:

- matching language providers receive an open snapshot;
- unmatched providers do not start;
- worker startup is lazy;
- incremental versions are monotonic;
- stale completion results are discarded;
- stale diagnostics are discarded;
- plugin disable/removal/crash clears provider state;
- document close retires requests and diagnostics;
- capability denial blocks document text;
- resource caps fail closed without affecting the editor;
- provider restart reopens current documents from fresh snapshots.

### Renderer unit tests

Prove:

- Monaco 1-based positions convert to zero-based UTF-16 protocol positions;
- Monaco content changes preserve range/text/order;
- completion requests carry current document version;
- Monaco cancellation sends cancel exactly once;
- stale response never becomes a suggestion;
- diagnostics map to isolated marker owners;
- stale diagnostics do not set markers;
- bridge disposal cancels requests, clears markers, and closes the document.

### Integration/E2E proof

Use a fixture plugin implementing deterministic completions and diagnostics.

Acceptance journey:

1. install/enable fixture provider;
2. open a source file;
3. type a token that only the fixture understands;
4. invoke completion and observe the fixture suggestion;
5. type a fixture-defined invalid token and observe an inline diagnostic;
6. change the token and observe the diagnostic disappear;
7. disable the plugin and observe completions/markers disappear while editing remains functional.

No real external language server is required for the core PR acceptance test.

## 21. Acceptance criteria

The feature is complete when all are true:

1. A third-party plugin can declare a language provider without renderer access.
2. Matching source documents are synchronized with unsaved text incrementally.
3. A plugin can return completion items that appear in Monaco.
4. A plugin can publish diagnostics that appear as Monaco markers.
5. Stale versions never surface completions or diagnostics.
6. Completion cancellation propagates to the worker and late results are discarded.
7. Disabling/removing/crashing a provider leaves no stale requests or markers.
8. Plugins without `editor:languageService` receive no document source text.
9. No existing Monaco TypeScript/JavaScript diagnostics are re-enabled.
10. With no editor provider installed, Orca source editing behavior is unchanged.
11. The core PR does not add language-server spawning or an LSP dependency.
12. Focused unit/integration tests and the fixture-plugin E2E pass.

## 22. Follow-up extensions

After the MVP is stable, the same transport can add feature enums and typed request/response contracts for:

- hover;
- definition;
- references;
- signature help;
- code actions;
- formatting;
- rename;
- semantic tokens;
- inlay hints.

`process:exec` and `orca-lsp` remain separate designs.

## 23. Design self-review

- No TODO/TBD placeholders remain.
- Monaco is not exposed publicly.
- The MVP has one capability and two language features only.
- Document versions are explicit on every stale-sensitive operation.
- Cancellation is first-class.
- Diagnostics ownership and cleanup are deterministic.
- Worker restart has a defined resynchronization path.
- Resource limits and failure behavior are specified.
- LSP/process execution are explicitly out of scope.
- Existing Monaco diagnostics remain unchanged.
