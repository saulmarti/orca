# Orca TypeScript Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `stablyai.orca-typescript`, a first-party bundled TypeScript/JavaScript language-service plugin providing real completions and diagnostics through Orca's Editor Provider API.

**Architecture:** Extend the editor document contract with `relativePath`; add a worker-only `workspace:readFiles` capability backed by router-derived worktree leases and Orca runtime file routing. The plugin embeds `@typescript/typescript6`, maintains a bounded VFS and persistent LanguageService per configured/inferred project, and publishes completions/diagnostics through the existing provider bridge.

**Tech Stack:** TypeScript 7 Orca core, `@typescript/typescript6@6.0.2` inside plugin tooling, Zod, Vitest, esbuild, Electron, Monaco, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-orca-typescript-plugin-design.md`

## Global Constraints

- NO production code without a focused failing test first.
- Orca core remains on TypeScript 7; only the plugin uses TypeScript 6 programmatic APIs.
- Plugin source never reads workspace repositories using `node:fs` or `node:fs/promises`.
- Workspace reads require both `workspace:readFiles` consent and an active router-derived plugin/worktree lease.
- `readFiles`: max 256 paths, 4 MiB/file, 8 MiB response; no silent truncation.
- `readDirectory`: shallow, max 2,048 entries.
- Warm completion product target: P95 < 100 ms on the reference machine.
- Monaco native TS/JS diagnostics remain disabled.
- Out of scope: hover/definition/references/rename/code actions/formatting/LSP/process spawning/additional import edits.

---

### Task 1: Editor contract and capability surface

**Files:**
- Modify: `src/shared/plugins/plugin-editor-protocol.ts`
- Modify: `src/shared/plugins/plugin-editor-protocol.test.ts`
- Modify: `src/shared/plugins/plugin-capabilities.ts`
- Modify: `src/shared/plugins/plugin-manifest.test.ts`
- Modify: `src/renderer/src/components/editor/plugin-editor/editor-plugin-bridge.ts`
- Modify: `src/renderer/src/components/editor/plugin-editor/editor-plugin-bridge.test.ts`
- Modify call site(s) that construct `attachEditorPluginBridge(...)`.

**Interfaces:**
- `EditorDocumentOpen` gains `relativePath: string`.
- New capability kind: `workspace:readFiles` with consent copy exactly matching the spec intent.
- `attachEditorPluginBridge` receives `relativePath` and forwards it in `editorOpen`.

- [ ] **Step 1: Write RED tests** proving the schema rejects missing `relativePath`, accepts a bounded worktree-relative value, the manifest accepts/fingerprints `workspace:readFiles`, and the renderer forwards `relativePath`.
- [ ] **Step 2: Run focused tests** with `pnpm exec vitest run --config config/vitest.config.ts src/shared/plugins/plugin-editor-protocol.test.ts src/shared/plugins/plugin-manifest.test.ts src/renderer/src/components/editor/plugin-editor/editor-plugin-bridge.test.ts`; verify failures are the missing contract/capability.
- [ ] **Step 3: Implement the minimum contract changes**: add the strict field/schema/type, capability enum/description, bridge argument, and call-site propagation from the existing `activeFile.relativePath` data.
- [ ] **Step 4: Re-run focused tests** and make them green without changing unrelated editor behavior.
- [ ] **Step 5: Commit** as `feat(plugins): extend editor documents for workspace language services`.

### Task 2: Router-owned editor/worktree leases

**Files:**
- Create: `src/main/plugins/plugin-editor-worktree-leases.ts`
- Create: `src/main/plugins/plugin-editor-worktree-leases.test.ts`
- Modify: `src/main/plugins/plugin-editor-router-types.ts`
- Modify: `src/main/plugins/plugin-editor-router.ts`
- Modify: `src/main/plugins/plugin-editor-router.test.ts`
- Modify: `src/main/plugins/plugin-service.ts`

**Interfaces:**
- `PluginEditorWorktreeLeases.acquire(pluginKey, worktreeId, documentKey): void`
- `release(pluginKey, worktreeId, documentKey): void`
- `revokePlugin(pluginKey): void`
- `has(pluginKey, worktreeId): boolean`
- Router options receive lease callbacks/object; router remains the sole source of lease truth.

- [ ] **Step 1: Write RED tests** for first-open acquisition, multiple-document refcounts, final-close revocation, owner revoke, plugin revoke, and worker-gone revoke.
- [ ] **Step 2: Run** `pnpm exec vitest run --config config/vitest.config.ts src/main/plugins/plugin-editor-worktree-leases.test.ts src/main/plugins/plugin-editor-router.test.ts src/main/plugins/plugin-service-editor-router.test.ts`; verify lease assertions fail before implementation.
- [ ] **Step 3: Implement the lease store and router integration** using `document.worktreeId`; make revoke paths idempotent.
- [ ] **Step 4: Re-run focused tests** and verify existing completion/diagnostic routing tests remain green.
- [ ] **Step 5: Commit** as `feat(plugins): track editor worktree leases`.

### Task 3: Secure worker-only workspace file API

**Files:**
- Modify: `src/shared/plugins/plugin-host-api.ts`
- Modify: `src/shared/plugins/plugin-capability-gate.ts` tests / host conformance tests
- Modify: `src/main/plugins/plugin-host-method-bindings.ts`
- Modify: `src/main/plugins/plugin-host-methods.test.ts`
- Modify: `src/main/plugins/plugin-host-service-bindings.ts`
- Create: `src/main/plugins/plugin-workspace-file-access.ts`
- Create: `src/main/plugins/plugin-workspace-file-access.test.ts`
- Modify runtime structural delegate only as needed to reuse existing local/remote file routing.

**Interfaces:**
- `workspace.readDirectory({ worktreeId, path })`
- `workspace.statFiles({ worktreeId, paths })`
- `workspace.readFiles({ worktreeId, paths })`
- All three: capability `workspace:readFiles`, `panel: false`, scope `active-worktree`/explicit leased-worktree equivalent.
- Host service must call `leases.has(pluginId, worktreeId)` before path resolution.

- [ ] **Step 1: Write RED schema/gate tests** proving the three methods exist, panels are denied, missing capability is denied, absolute/traversal paths are rejected, and batch limits are enforced.
- [ ] **Step 2: Write RED service tests** using fake runtime delegates for local and remote-style routing; assert missing/not-file/too-large are per-path results and no content is truncated.
- [ ] **Step 3: Run focused host tests** and verify the failures come from missing methods/service implementation.
- [ ] **Step 4: Implement path normalization + bounded result types** in `plugin-workspace-file-access.ts`; reject escape-capable paths before runtime access and preserve lease authority.
- [ ] **Step 5: Bind runtime file operations** through the structural delegate; do not pass raw runtime service objects to plugins and do not reuse the 512 KiB mobile-preview truncation path.
- [ ] **Step 6: Re-run host/gate/conformance tests**; confirm panel denial and local/remote fake routes both pass.
- [ ] **Step 7: Commit** as `feat(plugins): add leased workspace file reads`.

### Task 4: TypeScript plugin foundation, VFS, and project resolution

**Files:**
- Create: `plugins/orca-typescript/package.json` or repository-equivalent source manifest for plugin build inputs.
- Create: `plugins/orca-typescript/src/document-store.ts`
- Create: `plugins/orca-typescript/src/workspace-file-cache.ts`
- Create: `plugins/orca-typescript/src/project-resolver.ts`
- Create: focused colocated/test files for each unit.
- Modify: root `package.json` / `pnpm-lock.yaml` to add `@typescript/typescript6@6.0.2` as build/test dependency without replacing TypeScript 7.

**Interfaces:**
- `DocumentStore.open/change/close` owns editor overlays and applies zero-based UTF-16 incremental edits.
- `WorkspaceFileCache` stores worktree-relative disk records with 32 MiB/project and 128 MiB/worker LRU budgets; open overlays override disk records.
- `ProjectResolver.resolve(worktreeId, relativePath)` chooses nearest `tsconfig.json`, then `jsconfig.json`; inferred root uses nearest `package.json` then worktree root.

- [ ] **Step 1: Write RED DocumentStore tests** for incremental UTF-16 edits, version monotonicity, close restoring disk content, and temporary-file removal.
- [ ] **Step 2: Run those tests** and verify failure because units do not exist.
- [ ] **Step 3: Implement minimal DocumentStore** and make its tests green.
- [ ] **Step 4: Write RED cache/resolver tests** for overlay precedence, cache eviction bounds, nearest-config precedence, `tsconfig` over sibling `jsconfig`, inferred roots, and two-project isolation.
- [ ] **Step 5: Implement cache/resolver** with async hydration outside TypeScript synchronous host callbacks.
- [ ] **Step 6: Add TS6 dependency** only after a RED test imports the compatibility API and fails; verify root `typescript` remains 7.x.
- [ ] **Step 7: Run plugin unit suite** and root typechecks relevant to changed shared/main code.
- [ ] **Step 8: Commit** as `feat(typescript-plugin): add document cache and project resolution`.

### Task 5: Persistent TypeScript projects and completions

**Files:**
- Create: `plugins/orca-typescript/src/typescript-project.ts`
- Create: `plugins/orca-typescript/src/completion-adapter.ts`
- Create: `plugins/orca-typescript/src/project-manager.ts`
- Create: focused tests for all three.

**Interfaces:**
- `TypeScriptProject` owns one persistent `ts.LanguageService`, compiler options, script versions, project version, and synchronous host backed only by hydrated VFS state.
- `ProjectManager` keys projects by `worktreeId + config/inferred root` and disposes only structurally invalidated projects.
- `provideCompletions(document, position)` returns Orca `EditorCompletionList` and maps TS `replacementSpan` to `textEdit`.

- [ ] **Step 1: Write RED completion tests** for inferred object property, interface property, local symbol, cross-file import resolution, and auto-import candidate visibility, plus TSX and JSX parsing/completion coverage.
- [ ] **Step 2: Add RED lifecycle assertions** proving normal document edits increment script/project versions without recreating the LanguageService instance.
- [ ] **Step 3: Run focused plugin tests** and verify failures are missing TS project/completion behavior.
- [ ] **Step 4: Implement `LanguageServiceHost` over VFS** with bundled lib declaration lookup, `getScriptSnapshot`, `getScriptVersion`, `getProjectVersion`, module resolution, and configured/inferred compiler options.
- [ ] **Step 5: Implement completion adapter** mapping relevant `ScriptElementKind` values, sort/filter/insert text, replacement spans, and protocol item limits; do not implement additional import edits.
- [ ] **Step 6: Re-run completion/lifecycle tests** and keep the same LanguageService object across ordinary edits.
- [ ] **Step 7: Commit** as `feat(typescript-plugin): provide project-aware completions`.

### Task 6: Diagnostics, debounce, and dependency invalidation

**Files:**
- Create: `plugins/orca-typescript/src/diagnostic-adapter.ts`
- Create: `plugins/orca-typescript/src/diagnostics-scheduler.ts`
- Extend: `plugins/orca-typescript/src/project-manager.ts`
- Extend: `plugins/orca-typescript/src/typescript-project.ts`
- Create/extend focused tests.

**Interfaces:**
- Diagnostics use `getSyntacticDiagnostics(file)` + `getSemanticDiagnostics(file)`.
- `DiagnosticsScheduler` debounces ~300 ms per document and tags each run with a generation; stale generations never publish.
- Dependency freshness checks re-stat/re-read known closed dependencies before diagnostics; changed dependency scripts bump versions and reschedule diagnostics for open importers in the same project.

- [ ] **Step 1: Write RED diagnostic tests** for syntax error, semantic error, corrected error clearing with `diagnostics: []`, and TS diagnostic code/source mapping.
- [ ] **Step 2: Write RED scheduling tests** proving rapid edits collapse to one run and an older generation cannot publish after a newer edit.
- [ ] **Step 3: Write RED invalidation tests** where a closed imported file changes on disk/cache and causes an importing open document to be re-diagnosed; config changes rebuild only the affected project.
- [ ] **Step 4: Run focused tests** and verify all failures represent missing diagnostics/scheduling/invalidation behavior.
- [ ] **Step 5: Implement diagnostic adapter/scheduler** and directed stamp refresh; keep completion path independent from slow revalidation.
- [ ] **Step 6: Re-run tests** including two-tsconfig isolation and close-overlay cases.
- [ ] **Step 7: Commit** as `feat(typescript-plugin): add diagnostics and dependency invalidation`.

### Task 7: Worker activation, bundling, and bundled-plugin integrity

**Files:**
- Create: `plugins/orca-typescript/src/index.ts`
- Create: `plugins/orca-typescript/build.mjs`
- Create: `plugins/orca-typescript/orca-plugin.json`
- Create generated artifact: `resources/plugins/launch/stablyai.orca-typescript/**`
- Modify: `resources/plugins/launch/bundled-plugins.json`
- Modify/add packaging/integrity tests under `src/main/plugins/` and `config/scripts/` as appropriate.

**Interfaces:**
- Worker activates one editor provider for `typescript`, `typescriptreact`, `javascript`, `javascriptreact` with `completion` + `diagnostics` and capabilities `editor:languageService` + `workspace:readFiles`.
- Worker calls only `orca.editor.*` and worker host `workspace.*`; no direct repository `node:fs` imports.
- Build outputs self-contained `worker.mjs` plus the full TS6 standard `lib*.d.ts` set and a valid manifest.

- [ ] **Step 1: Write RED worker integration test** loading the source/built worker against a fake Orca SDK and asserting provider registration, open/change/close wiring, completion delegation, diagnostics publication, and final-lease cleanup behavior.
- [ ] **Step 2: Write RED artifact tests** asserting manifest identity/capabilities, no symlinks, no workspace `node:fs` imports, standard libs present, generated tree < 50 MiB, and deterministic content hash/index entry.
- [ ] **Step 3: Run worker/artifact tests** and verify failures come from missing plugin/build output.
- [ ] **Step 4: Implement activation and build script** using esbuild to bundle TS6 programmatic runtime; copy TS6 standard libraries and generate/copy the runtime manifest.
- [ ] **Step 5: Generate the bundled artifact and update `bundled-plugins.json`** through existing hash/integrity conventions rather than inventing a new loader.
- [ ] **Step 6: Re-run worker, bundled-bootstrap, packaged-plugin-resource, and content-hash tests**.
- [ ] **Step 7: Commit** as `feat(typescript-plugin): bundle first-party language service`.

### Task 8: Real Monaco E2E, performance evidence, and release verification

**Files:**
- Modify: `tests/e2e/plugin-editor-provider.spec.ts` or add `tests/e2e/typescript-editor-provider.spec.ts`.
- Add: a focused benchmark/contract test under `plugins/orca-typescript/` or `config/` matching repository benchmark conventions.
- Modify plan checkboxes as tasks complete.

**Interfaces:**
- E2E installs/activates the real `stablyai.orca-typescript` artifact, never a hardcoded completion fixture.
- Temporary project contains at least `tsconfig.json`, `src/user.ts`, `src/example.ts`.
- Benchmark warms the project and reports sample count, P50, P95, and max; product target P95 < 100 ms.

- [ ] **Step 1: Write/convert the E2E to RED**: real `user.na| → name`, semantic type-error squiggly, correction clears, disabling plugin removes provider completion while Monaco stays editable.
- [ ] **Step 2: Run the dedicated Electron test** and verify it fails for the first missing vertical integration behavior rather than fixture/setup noise.
- [ ] **Step 3: Make only the minimum integration changes needed** to get the real plugin E2E green; do not add language features outside the spec.
- [ ] **Step 4: Add/run the warm completion benchmark** after a RED contract establishes reporting/threshold behavior; capture P50/P95/max evidence.
- [ ] **Step 5: Run focused feature suite + `pnpm run typecheck` + changed-code/type-aware/reliability/max-lines gates + bundled-plugin verification + dedicated E2E**.
- [ ] **Step 6: Classify any broad-suite failures against base before touching unrelated code**; do not absorb ambient failures.
- [ ] **Step 7: Commit** as `test(typescript-plugin): verify real editor language service`.

## Final Verification

Before claiming completion, use `superpowers:verification-before-completion` and gather fresh evidence for:

```text
git status --short --branch
focused Vitest plugin/editor/host suites
pnpm run typecheck
pnpm run check:code-quality:changed
pnpm run audit:code-quality:type-aware
pnpm run check:reliability-gates
pnpm run check:max-lines-ratchet
packaged/bundled plugin verification
real TypeScript-provider Playwright E2E
warm completion benchmark report
```

Then use `superpowers:finishing-a-development-branch` to decide integration/PR handling. Do not merge automatically unless explicitly requested.