# Orca Editor Provider API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a capability-gated, out-of-process Editor Provider API that lets Orca plugins provide Monaco completions and diagnostics without exposing Monaco or embedding LSP into core.

**Architecture:** Plugins declare `editorProviders` in `orca-plugin.json`. Orca lazily activates the existing worker, validates the worker's provider registrations, exposes worker-backed proxies through the existing typed `PluginExtensionRegistry`, and routes versioned document/completion/diagnostic traffic over a dedicated renderer↔main↔worker protocol. Monaco remains renderer-owned; plugins only see neutral zero-based UTF-16 protocol values.

**Tech Stack:** TypeScript, Zod, Electron IPC, `child_process.fork`, Monaco Editor, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-orca-editor-provider-api-design.md`

## Global Constraints

- MVP features are exactly `completion` and `diagnostics`.
- Add exactly one capability: `editor:languageService`.
- Do not expose Monaco, renderer DOM, Electron objects, or renderer JavaScript to plugins.
- Do not add LSP dependencies, language-server spawning, `process:exec`, hover, definition, rename, references, formatting, code actions, semantic tokens, inlay hints, or signature help.
- Keep current Monaco TypeScript/JavaScript diagnostics disabled.
- Positions are zero-based UTF-16 line/character pairs.
- Every stale-sensitive operation carries a monotonically increasing document version.
- Completion cancellation is first-class; late/stale responses are discarded.
- Diagnostics are isolated per `pluginKey/providerId` marker owner.
- Worker/plugin/document teardown clears pending requests and diagnostics deterministically.
- All plugin-originated payloads are Zod-validated and resource-bounded.
- TDD is mandatory: RED CI proof before production code for each behavior.

---

### Task 1: Manifest contribution and consent capability

**Files:**
- Create: `src/shared/plugins/plugin-editor-contributions.ts`
- Create: `src/shared/plugins/plugin-editor-contributions.test.ts`
- Modify: `src/shared/plugins/plugin-manifest.ts`
- Modify: `src/shared/plugins/plugin-manifest.test.ts`
- Modify: `src/shared/plugins/plugin-manifest-contribution-validation.ts`
- Modify: `src/shared/plugins/plugin-capabilities.ts`

**Interfaces:**
```ts
export const PLUGIN_EDITOR_PROVIDER_LIMIT = 16
export const PLUGIN_EDITOR_PROVIDER_LANGUAGE_LIMIT = 32
export const PLUGIN_EDITOR_PROVIDER_FEATURES = ['completion', 'diagnostics'] as const
export type PluginEditorProviderFeature = (typeof PLUGIN_EDITOR_PROVIDER_FEATURES)[number]
export const pluginEditorProviderContributionSchema: z.ZodType<{
  id: string
  languages: string[]
  features: PluginEditorProviderFeature[]
}>
```

- [ ] **Step 1: Write failing tests** proving a valid provider parses, duplicate provider ids fail, invalid features fail, and providers require both `main` and `editor:languageService`.

```ts
it('accepts an editor provider with language-service consent', () => {
  expect(
    parsePluginManifest(
      manifest({
        main: 'worker.mjs',
        contributes: {
          panels: [], commands: [], events: [],
          editorProviders: [{
            id: 'typescript',
            languages: ['typescript', 'javascript'],
            features: ['completion', 'diagnostics']
          }]
        },
        capabilities: [{ kind: 'editor:languageService' }]
      })
    ).ok
  ).toBe(true)
})
```

- [ ] **Step 2: Verify RED in CI**
```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/shared/plugins/plugin-manifest.test.ts \
  src/shared/plugins/plugin-editor-contributions.test.ts \
  src/shared/plugins/plugin-consent-fingerprint.test.ts
```
Expected: failure because strict manifest schema rejects `editorProviders` and the capability enum rejects `editor:languageService`.

- [ ] **Step 3: Implement minimal schema/capability** with bounded arrays, duplicate language rejection, duplicate provider validation, `main` requirement, and consent text:
```ts
'editor:languageService':
  'Read source text while you edit and provide editor suggestions and diagnostics'
```

- [ ] **Step 4: Verify GREEN** with the same focused command.

- [ ] **Step 5: Commit**
```bash
git commit -am "feat(plugins): declare editor providers"
```

---

### Task 2: Neutral editor protocol schemas

**Files:**
- Create: `src/shared/plugins/plugin-editor-protocol.ts`
- Create: `src/shared/plugins/plugin-editor-protocol.test.ts`

**Interfaces:**
```ts
editorPositionSchema
editorRangeSchema
editorDocumentOpenSchema
editorDocumentChangeSchema
editorDocumentCloseSchema
editorCompletionRequestSchema
editorCompletionResponseSchema
editorDiagnosticsPublicationSchema
editorCancelRequestSchema
```

- [ ] **Step 1: Write failing protocol-boundary tests** for nonnegative positions/versions, incremental changes, completion caps, diagnostics caps, and payload byte budgets.

- [ ] **Step 2: Verify RED**
```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/shared/plugins/plugin-editor-protocol.test.ts
```
Expected: module missing.

- [ ] **Step 3: Implement schemas** with MVP limits:
```ts
export const PLUGIN_EDITOR_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024
export const PLUGIN_EDITOR_CHANGE_BATCH_MAX_BYTES = 256 * 1024
export const PLUGIN_EDITOR_COMPLETION_ITEM_LIMIT = 512
export const PLUGIN_EDITOR_DIAGNOSTIC_LIMIT = 2048
export const PLUGIN_EDITOR_MESSAGE_MAX_LENGTH = 8192
```
Use `Buffer.byteLength(JSON.stringify(value), 'utf8')` for aggregate byte refinements.

- [ ] **Step 4: Verify GREEN**.

- [ ] **Step 5: Commit**
```bash
git commit -m "feat(plugins): define editor provider protocol"
```

---

### Task 3: Worker SDK registration, completion and diagnostics

**Files:**
- Modify: `src/shared/plugins/plugin-host-protocol.ts`
- Modify: `src/main/plugins/plugin-host-runtime.ts`
- Modify: `src/main/plugins/plugin-host-runtime.test.ts`

**Interfaces:**
Parent worker messages add document open/change/close, completion request and cancel. Child messages add completion result and diagnostics. `ready` gains `editorProviders: string[]`.

Plugin SDK adds:
```ts
editor: {
  registerProvider(providerId: string, provider: PluginEditorProvider): { dispose(): void }
  publishDiagnostics(providerId: string, publication: EditorDiagnosticsPublication): void
}
```

- [ ] **Step 1: Write failing runtime tests** for provider registration in `ready`, document event delivery order, completion result, cancellation `AbortSignal`, diagnostics publication, and shutdown abort.

- [ ] **Step 2: Verify RED**
```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/plugins/plugin-host-runtime.test.ts
```
Expected: `orca.editor` and editor message variants are absent.

- [ ] **Step 3: Implement minimal worker API** using:
```ts
const editorProviders = new Map<string, PluginEditorProvider>()
const pendingEditorRequests = new Map<string, AbortController>()
```
A cancelled request never emits a result; shutdown aborts every pending request before `deactivate`.

- [ ] **Step 4: Verify GREEN**.

- [ ] **Step 5: Commit**
```bash
git commit -m "feat(plugins): add editor worker SDK"
```

---

### Task 4: Worker process transport and extension proxy

**Files:**
- Modify: `src/main/plugins/plugin-host-process.ts`
- Modify: `src/shared/plugins/plugin-extension-registry.ts`
- Modify: `src/main/plugins/plugin-worker-controller.ts`
- Test: `src/main/plugins/plugin-worker-controller.test.ts`
- Test: closest existing `plugin-host-process` tests

**Interfaces:**
Extend `PluginWorkerHandle` with `editorProviders`, document send methods, abortable completion request/cancel, and diagnostic subscription. Add `PLUGIN_EDITOR_PROVIDER_EXTENSION_POINT` whose implementation is a worker-backed proxy.

- [ ] **Step 1: Write failing tests** proving worker completion correlation, diagnostic fan-out, and rejection of undeclared provider registrations.

```ts
await expect(controller.ensure(plugin)).rejects.toThrow(
  'registered undeclared editor provider not-declared'
)
```

- [ ] **Step 2: Verify RED** with the focused controller/process tests.

- [ ] **Step 3: Implement transport and provider validation**. The controller compares `handle.editorProviders` against `plugin.manifest.contributes.editorProviders`, then registers one proxy per provider id in the existing extension registry.

- [ ] **Step 4: Verify GREEN**.

- [ ] **Step 5: Commit**
```bash
git commit -m "feat(plugins): route editor providers through workers"
```

---

### Task 5: Main-process editor router

**Files:**
- Create: `src/main/plugins/plugin-editor-router.ts`
- Create: `src/main/plugins/plugin-editor-router.test.ts`
- Modify: `src/main/plugins/plugin-service.ts`

**Interfaces:**
```ts
open(ownerKey: string, document: EditorDocumentOpen): Promise<EditorProviderBinding[]>
change(ownerKey: string, change: EditorDocumentChange): void
close(ownerKey: string, documentId: string, finalVersion: number): void
complete(ownerKey: string, request: EditorCompletionRequest): Promise<EditorCompletionResponse | null>
cancel(ownerKey: string, requestId: string): void
revokeOwner(ownerKey: string): void
revokePlugin(pluginKey: string): void
```

- [ ] **Step 1: Write failing router tests** for lazy activation, language matching, lexical completion-provider selection, all matching diagnostic bindings, strictly monotonic versions, stale completion/diagnostic rejection, close cleanup, and owner/plugin revocation.

- [ ] **Step 2: Verify RED**
```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/plugins/plugin-editor-router.test.ts
```
Expected: router missing.

- [ ] **Step 3: Implement minimal router**. Completion selection sorts `${pluginKey}/${providerId}` lexically and uses the first match. Main remains capability/security authority.

- [ ] **Step 4: Verify GREEN**.

- [ ] **Step 5: Commit**
```bash
git commit -m "feat(plugins): add editor provider router"
```

---

### Task 6: Renderer IPC/preload bridge

**Files:**
- Modify: `src/main/ipc/plugins.ts`
- Modify: `src/preload/api/plugin-host-api.ts`
- Modify: `src/preload/api/plugins-bridge.ts`
- Test: focused plugin IPC/preload contract tests

**Interfaces:**
```ts
editorOpen(args: EditorDocumentOpen): Promise<EditorProviderBinding[]>
editorChange(change: EditorDocumentChange): Promise<void>
editorClose(args: EditorDocumentClose): Promise<void>
editorComplete(request: EditorCompletionRequest): Promise<EditorCompletionResponse | null>
editorCancel(args: EditorCancelRequest): Promise<void>
onEditorDiagnostics(callback: (event: RendererEditorDiagnosticsEvent) => void): () => void
```

- [ ] **Step 1: Write failing IPC tests** proving malformed payload rejection, owner identity from `event.sender.id`, sender destruction cleanup, and owner-scoped diagnostic delivery.

- [ ] **Step 2: Verify RED**.

- [ ] **Step 3: Implement handlers/preload methods**. Renderer never supplies its authority/owner id.

- [ ] **Step 4: Verify GREEN**.

- [ ] **Step 5: Commit**
```bash
git commit -m "feat(plugins): expose editor provider renderer bridge"
```

---

### Task 7: Monaco adapters and document bridge

**Files:**
- Create: `src/renderer/src/components/editor/plugin-editor/editor-plugin-position.ts`
- Create: `src/renderer/src/components/editor/plugin-editor/editor-plugin-position.test.ts`
- Create: `src/renderer/src/components/editor/plugin-editor/editor-plugin-monaco-completions.ts`
- Create: `src/renderer/src/components/editor/plugin-editor/editor-plugin-monaco-completions.test.ts`
- Create: `src/renderer/src/components/editor/plugin-editor/editor-plugin-monaco-diagnostics.ts`
- Create: `src/renderer/src/components/editor/plugin-editor/editor-plugin-monaco-diagnostics.test.ts`
- Create: `src/renderer/src/components/editor/plugin-editor/editor-plugin-bridge.ts`
- Create: `src/renderer/src/components/editor/plugin-editor/editor-plugin-bridge.test.ts`
- Modify: `src/renderer/src/components/editor/use-monaco-editor-mount.ts`

**Interfaces:**
```ts
export function attachEditorPluginBridge(args: {
  editorInstance: monaco.editor.IStandaloneCodeEditor
  monaco: typeof import('monaco-editor')
  worktreeId: string
  filePath: string
  languageId: string
}): { dispose(): void }
```

- [ ] **Step 1: Write failing pure adapter/bridge tests** proving Monaco 1-based→protocol 0-based conversion, open snapshot version 1, ordered incremental changes, completion current-version capture, cancel exactly once, stale completion suppression, marker owner isolation, stale diagnostic suppression, and disposal cleanup.

```ts
expect(toEditorPosition({ lineNumber: 3, column: 5 })).toEqual({
  line: 2,
  character: 4
})
```

- [ ] **Step 2: Verify RED**
```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/editor/plugin-editor
```
Expected: modules missing.

- [ ] **Step 3: Implement adapters/bridge**. Attach the bridge only after `syncContentOnMount(...)` completes so the first snapshot is the actual visible in-memory text. Dispose it in the existing `editorInstance.onDidDispose` callback.

Do **not** modify `src/renderer/src/lib/monaco-setup.ts`; its disabled TS/JS diagnostics remain intact.

- [ ] **Step 4: Verify GREEN** including existing Monaco mount tests.

- [ ] **Step 5: Commit**
```bash
git commit -m "feat(editor): connect Monaco to plugin providers"
```

---

### Task 8: Fixture plugin, E2E, quality gates and upstream PR

**Files:**
- Create: `examples/plugins/editor-provider-fixture/orca-plugin.json`
- Create: `examples/plugins/editor-provider-fixture/worker.mjs`
- Create: `tests/e2e/plugin-editor-provider.spec.ts`

**Fixture contract:** TypeScript completion returns `fixtureCompletion`; document text containing `fixture_error` publishes one error diagnostic; removing it publishes an empty diagnostic list.

- [ ] **Step 1: Add failing E2E** covering enable fixture → open TS file → completion visible → diagnostic appears → remove token → diagnostic clears → disable plugin → provider UI disappears while editing remains functional.

- [ ] **Step 2: Verify RED**
```bash
pnpm run ensure:electron-runtime
pnpm exec playwright test tests/e2e/plugin-editor-provider.spec.ts \
  --config tests/playwright.config.ts \
  --project electron-headless \
  --workers=1
```

- [ ] **Step 3: Fix only integration seams demonstrated by E2E failures**; add no new provider feature.

- [ ] **Step 4: Run final verification**
```bash
pnpm typecheck
pnpm run check:code-quality:changed -- main
pnpm run check:max-lines-ratchet
pnpm run check:reliability-gates
pnpm exec vitest run --config config/vitest.config.ts \
  src/shared/plugins \
  src/main/plugins \
  src/renderer/src/components/editor/plugin-editor
pnpm run build:electron-vite
```

- [ ] **Step 5: Self-review acceptance criteria**: no Monaco/DOM/Electron exposure; no LSP/process dependency; capability denial blocks source; stale versions never surface; disable/remove/crash cleanup is deterministic; existing Monaco diagnostics remain disabled; no-provider behavior remains unchanged.

- [ ] **Step 6: Open draft upstream PR**
```text
feat(plugins): add editor provider API
```
PR body must document isolation, lazy activation, explicit source-text consent, no LSP/server spawning in core, deterministic fixture proof, remote/worktree ownership, and exact validation results.
