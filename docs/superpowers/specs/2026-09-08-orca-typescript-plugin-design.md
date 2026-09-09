# Orca TypeScript Language Service Plugin Design

**Date:** 2026-09-08
**Status:** Approved architecture, pending written-spec review
**Target:** `stablyai/orca`
**Working fork:** `saulmarti/orca`
**Branch:** `feat/typescript-editor-provider`
**Scope:** First-party TypeScript/JavaScript editor provider plugin backed by the TypeScript Language Service.

## 1. Goal

Prove that Orca's Editor Provider API can deliver a useful IDE experience through an isolated plugin rather than by embedding language intelligence into editor core.

The plugin is named `orca-typescript` and ships with the qualified identity `stablyai.orca-typescript`.

The MVP supports:

- `.ts`, `.tsx`, `.js`, and `.jsx`;
- real TypeScript Language Service completions;
- type-aware property and local-symbol completions;
- project-aware cross-file completions;
- TypeScript-provided auto-import candidates when representable by the existing completion contract;
- syntactic diagnostics;
- semantic diagnostics;
- `tsconfig.json` and `jsconfig.json`;
- JSX and TSX;
- incremental open-document updates;
- debounced diagnostics;
- project invalidation when dependent files or configuration change;
- multiple independent configured projects in one worktree.
The MVP explicitly does **not** add hover, definition, references, rename, signature help, code actions, formatting, semantic tokens, inlay hints, or a generic LSP adapter.

It also does not re-enable Monaco's built-in TypeScript/JavaScript diagnostics. Orca's current `noSemanticValidation`, `noSuggestionDiagnostics`, and `noSyntaxValidation` settings remain unchanged.

## 2. Existing platform constraints

The Editor Provider API already supplies:

- document open/change/close lifecycle;
- monotonic document versions;
- incremental edits;
- completion requests with cancellation;
- diagnostics publication;
- host-side stale completion suppression;
- host-side stale diagnostics suppression;
- deterministic provider selection for completion;
- multi-provider diagnostics;
- editor/provider teardown when plugins are disabled or workers disappear.

Plugins run in a separate Node process and do not receive Monaco, DOM, React, or renderer access.

The current `workspace:read` capability does **not** read files. It only exposes a projected focused-worktree context containing safe labels and terminal ids. Its consent meaning must not be expanded silently.

Although the current worker process can technically import Node filesystem modules, `orca-typescript` must not use arbitrary `node:fs` access. Workspace source access must remain capability-gated and host-mediated.

## 3. TypeScript runtime choice

Orca currently develops against TypeScript 7.0.x. That package no longer exposes the legacy programmatic language-service API through the main entry point.

For this plugin, use `@typescript/typescript6` as the compatibility dependency that provides the TypeScript 6 programmatic API needed for `createLanguageService()`.

This dependency belongs to the plugin build/runtime only. Orca core continues using its existing TypeScript 7 toolchain.

The plugin must be self-contained at runtime. It must not depend on Orca's root `node_modules` layout after installation.

A deterministic plugin build will bundle the TypeScript 6 JavaScript runtime into the worker artifact and copy the complete TypeScript 6 standard-library `lib*.d.ts` declaration set into the plugin tree. This keeps project `target`/`lib` choices independent from Orca's own TypeScript installation.

The build must fail if the resulting plugin tree exceeds Orca's existing plugin size limits.

## 4. Chosen architecture

```text
Monaco
  │
  ▼
Editor Provider API
  │
  ▼
stablyai.orca-typescript worker
  │
  ├─ DocumentStore
  ├─ WorkspaceFileCache
  ├─ ProjectResolver
  ├─ ProjectManager
  ├─ TypeScriptProject
  ├─ CompletionAdapter
  └─ DiagnosticsScheduler
```

### 4.1 DocumentStore

Owns open-document overlays independently from disk-backed workspace files.

Each open document stores:

```ts
type OpenDocument = {
  documentId: string
  worktreeId: string
  filePath: string
  relativePath: string
  languageId: string
  documentVersion: number
  scriptVersion: number
  text: string
}
```

`documentVersion` is the Orca editor protocol version used for stale-response protection. `scriptVersion` is the TypeScript host version used to invalidate language-service snapshots. They are related but conceptually separate.

`changeDocument` applies the protocol's incremental UTF-16 edits to the current overlay. It never asks the host for a full replacement snapshot after each keystroke.

On close, the overlay is removed. If the same relative path exists in the workspace cache, the TypeScript project falls back to that disk-backed snapshot; otherwise the script disappears from the project.

### 4.2 Editor document relative paths

Extend `EditorDocumentOpen` with a required `relativePath` field.

The renderer already knows both the file path and worktree identity. It must derive or carry the worktree-relative path at the editor bridge boundary rather than forcing plugins to parse opaque worktree ids or infer host paths.

All new workspace file APIs accept relative paths only. `filePath` remains useful as editor identity/display context, but `relativePath` is the portable key for language-service project access.

## 5. New capability: `workspace:readFiles`

Add a distinct capability instead of widening `workspace:read`.

Consent description:

> Read files in worktrees where this plugin is providing editor language services.

The capability is necessary but not sufficient. Every file operation is also checked against an active editor-worktree lease owned by the plugin.

Panel code may never call these methods. They are worker-only host methods.

### 5.1 Host methods

Add three read-only host methods:

```ts
workspace.readDirectory({ worktreeId, path })
workspace.statFiles({ worktreeId, paths })
workspace.readFiles({ worktreeId, paths })
```

`path` and every member of `paths` are normalized worktree-relative paths. The empty string represents the worktree root only where the method explicitly accepts a directory path.

`readDirectory` is shallow. Recursion remains under plugin control so a language service can traverse selectively instead of forcing the host to materialize a whole repository listing.

`statFiles` returns existence/type/size/mtime metadata without source contents.

`readFiles` returns text contents for regular text files only. Ordinary missing/oversized/non-file cases are represented per path; malformed paths, capability failures, and lease failures reject the host call.

Conceptual results:

```ts
type WorkspaceDirectoryResult =
  | { path: string; status: 'ok'; entries: Array<{ name: string; path: string }> }
  | { path: string; status: 'missing' | 'not-directory' }

type WorkspaceStatResult = {
  path: string
  status: 'ok' | 'missing'
  type?: 'file' | 'directory'
  byteLength?: number
  mtimeMs?: number
}

type WorkspaceReadResult =
  | { path: string; status: 'ok'; content: string; byteLength: number; mtimeMs: number }
  | { path: string; status: 'missing' | 'not-file' | 'too-large' | 'binary' }
```

The exact Zod schemas may be split into shared modules to keep existing host API files within ratchets, but these semantics are required.

### 5.2 Initial resource bounds

Initial limits:

- maximum 256 requested paths per `statFiles` or `readFiles` call;
- maximum 4 MiB per readable text file;
- maximum 8 MiB serialized/source-content budget per `readFiles` response;
- maximum 2,048 entries from one `readDirectory` call;
- no source truncation;
- no recursive directory method;
- explicit rejection when serialized request/response budgets are exceeded.

The plugin adds its own per-project cache budget so a large monorepo cannot grow one worker without bound.

### 5.3 Editor-worktree lease

A plugin may use `workspace:readFiles` for a worktree only while the Editor Provider Router has at least one open compatible document bound to that plugin in that worktree.

Conceptually:

```ts
type EditorWorkspaceLeaseKey = `${pluginKey}\0${worktreeId}`
```

The router owns lease truth. The plugin never creates or extends a lease itself.

Lease lifecycle:

- first bound editor document for plugin/worktree → acquire;
- additional bound documents → increment ownership/reference state;
- close/revoke document → decrement;
- last bound document closes → revoke;
- plugin disabled → revoke all leases immediately;
- worker disappears → revoke all leases immediately;
- renderer owner disappears → document teardown naturally revokes affected leases.

Host file methods receive `pluginKey` through the existing host-call execution context and consult the router-owned lease state before resolving any path.

The check uses the worktree identity from the editor protocol. It does not trust a filesystem path supplied by plugin code.

### 5.4 Path safety

The host resolves requested relative paths against the resolved runtime worktree, including local, folder-workspace, WSL, SSH, and other supported execution-host routes.

Reject:

- absolute paths;
- drive-absolute paths;
- `.` or `..` segments after normalization;
- empty file paths where a file is required;
- traversal outside the worktree;
- symlink resolution that escapes the authorized worktree;
- worktree ids without a current lease;
- attempts to use the API without `workspace:readFiles`.

File access should reuse Orca's runtime filesystem abstractions rather than adding a plugin-specific local filesystem implementation. This keeps language services compatible with remote worktrees and preserves existing host authority boundaries.

## 6. WorkspaceFileCache

The TypeScript Language Service host is synchronous. Orca host calls are asynchronous. Therefore the language service must never perform IPC from inside `getScriptSnapshot()`, `fileExists()`, `readFile()`, or related synchronous callbacks.

`WorkspaceFileCache` bridges that impedance mismatch:

1. asynchronously hydrate required workspace metadata/content;
2. store normalized relative-path records in memory;
3. expose synchronous lookup methods to `TypeScriptProject`;
4. refresh only stale or newly required records outside the completion hot path.

Conceptually:

```ts
type CachedWorkspaceFile = {
  relativePath: string
  text: string
  byteLength: number
  mtimeMs: number
  scriptVersion: number
}
```

Open documents are not copied into this cache as authoritative state. `DocumentStore` overlays win whenever a path is currently open.

The cache must support negative entries for known-missing paths so repeated TypeScript module-resolution probes do not generate repeated host calls.

Negative entries receive a shorter freshness window than successful file snapshots.

Cache eviction may remove disk-backed entries but must never remove the active overlay for an open document.

Initial cache policy is simple and bounded rather than predictive: disk-backed source text is limited to 32 MiB per project and 128 MiB per worker, using LRU eviction for unpinned entries. Open-document overlays and bundled standard libraries are not evicted by this disk-cache budget; they remain bounded separately by the existing editor document limits and plugin artifact limits. Configuration files and currently required declaration metadata are pinned while the project is active.

## 7. ProjectResolver

Project membership is resolved per open document.

For `src/features/example.ts`, walk upward from `src/features` to the worktree root and select the nearest configuration boundary in this order:

1. nearest `tsconfig.json`;
2. otherwise nearest `jsconfig.json`;
3. otherwise nearest `package.json` as inferred-project root;
4. otherwise the worktree root as inferred-project root.

A nearer `jsconfig.json` beats a farther `tsconfig.json`; "nearest configuration file" is the governing rule, with `tsconfig.json` winning only when both names exist in the same directory.

Configured project key:

```text
worktreeId + "\0config:" + configRelativePath
```

Inferred project key:

```text
worktreeId + "\0inferred:" + inferredRootRelativePath
```

Multiple projects in one worktree therefore receive separate `TypeScriptProject` instances and cannot share script/version state accidentally.

When a config file changes, only projects whose resolution boundary depends on that config are rebuilt/re-resolved.

When a document moves between project boundaries because config files appear/disappear/change, `ProjectManager` detaches it from the old project and attaches it to the newly resolved project.

## 8. Configured and inferred projects

### 8.1 Configured projects

Parse `tsconfig.json` / `jsconfig.json` with the TypeScript 6 configuration APIs using a cache-backed parse host.

Respect project-relevant options including:

- `files`;
- `include` / `exclude`;
- `extends` when the referenced config can be resolved inside the leased worktree or bundled TypeScript standard configuration context;
- `compilerOptions`;
- `baseUrl`;
- `paths`;
- `types`;
- `typeRoots`;
- `allowJs`;
- `checkJs`;
- `jsx`;
- module/module-resolution settings.

Configuration parsing may trigger asynchronous cache hydration before the synchronous TypeScript parse host is invoked. Missing or inaccessible config dependencies produce plugin logs and a degraded project rather than crashing the editor.

### 8.2 Inferred projects

When no tsconfig/jsconfig exists, create an inferred project rooted as described above.

Conservative defaults:

```ts
{
  allowJs: true,
  checkJs: false,
  allowNonTsExtensions: true,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler
}
```

Do not globally enable `checkJs: true` for inferred JavaScript projects. Semantic checking for JS follows explicit config, `// @ts-check`, and TypeScript behavior rather than surprising users with new global diagnostics.

## 9. TypeScriptProject and LanguageServiceHost

Each `TypeScriptProject` owns exactly one persistent TypeScript Language Service instance until the project boundary/configuration is structurally rebuilt.

The host implements the minimum synchronous surface needed by TypeScript, including:

```ts
getCompilationSettings()
getScriptFileNames()
getScriptVersion(fileName)
getScriptSnapshot(fileName)
getCurrentDirectory()
getDefaultLibFileName(options)
fileExists(fileName)
readFile(fileName)
readDirectory(...)
directoryExists(path)
getProjectVersion()
```

The exact TypeScript host interface may require additional compatibility members; they must remain thin cache-backed projections rather than new sources of authority.

Path conversion between TypeScript's virtual filenames and Orca relative paths is centralized in one module. No component independently normalizes Windows/WSL/POSIX separators.

The standard library declarations bundled with the plugin are mounted into a distinct virtual library namespace and are read synchronously without workspace host calls.

A normal document edit increments the script version for that file and the project version but does **not** recreate the Language Service.

A disk-backed dependency refresh increments only that dependency's script version plus the project version.

A structural configuration change may dispose and recreate that one `TypeScriptProject` because its root file set or compiler options can change materially.

## 10. Project hydration and dependency resolution

Do not recursively crawl `node_modules` or the whole worktree on every document open.

Hydration proceeds from useful roots:

1. project config and extended configs;
2. configured root files / include matches;
3. currently open documents;
4. imported/referenced local modules;
5. relevant package metadata;
6. package declaration entrypoints;
7. matching `@types` declarations when TypeScript resolution requires them;
8. referenced `.d.ts` files and transitive imports.

Directory listing is demand-driven and cacheable. Repeated module-resolution probes reuse cache state.

For package resolution, the plugin follows TypeScript's resolver behavior using the synchronous VFS. When the resolver probes a path that has not been hydrated yet, the plugin records the unresolved probe and schedules asynchronous hydration outside the current Language Service call.

After newly required files arrive, the project version increments and the initiating completion/diagnostic path may be retried once where doing so is bounded and useful.

No unbounded retry loop is permitted.

Completion requests must not wait for a broad project crawl. Cold projects may return a smaller first result while targeted hydration warms the cache; warm requests are the latency target.

Configured root discovery may enumerate project directories according to `include`/`exclude`, but it must honor workspace API limits, ignore obvious heavyweight excluded trees, and yield between asynchronous batches.

## 11. Completion flow

Completion is latency-sensitive and on-demand.

```text
EditorCompletionRequest
  ↓
verify open document/version
  ↓
resolve TypeScriptProject
  ↓
convert UTF-16 line/character → absolute offset
  ↓
languageService.getCompletionsAtPosition(...)
  ↓
CompletionAdapter
  ↓
EditorCompletionList
```

Before entering synchronous TypeScript work, check the supplied `AbortSignal`. Check it again after the Language Service returns and before adapting/sending results.

TypeScript 6 Language Service execution itself is synchronous and cannot be forcibly interrupted mid-call. Orca's existing worker and router cancellation/stale suppression remain the final safety net when a provider ignores or cannot honor an abort immediately.

The adapter maps TypeScript completion metadata onto the current Editor Provider protocol:

- entry name → `label`;
- TypeScript element kind → Orca completion kind;
- `sortText` → `sortText`;
- insertion text → `insertText`;
- replacement span → protocol `textEdit.range`;
- supported commit characters → `commitCharacters`;
- bounded useful detail/documentation when available without a second unbounded operation.

The adapter must cap results to the existing editor protocol item and byte budgets before publication.

### 11.1 Completion semantics required by MVP

The following must work in deterministic plugin tests:

```ts
const user = { name: 'Saul', age: 30 }
user.na|
```

must include `name`.

```ts
interface User { email: string }
declare const user: User
user.em|
```

must include `email`.

Local declarations and cross-file exported symbols visible to the TypeScript project must also appear when TypeScript supplies them.

### 11.2 Auto-import limitation

TypeScript may return a completion candidate that requires additional import edits. The current Orca `EditorCompletionItem` contract does not expose `additionalTextEdits` or completion-item resolve.

Therefore this PR guarantees that TypeScript-provided auto-import **candidates can be surfaced when their base completion entry is representable**, but it does not guarantee automatic insertion of the corresponding import statement.

Do not secretly extend the completion contract in this PR solely to emulate that behavior. Additional edits/resolution belong with the planned Editor Provider API expansion.

Tests must encode this distinction so the MVP is not later misread as supporting full VS Code-style auto-import application.

## 12. Diagnostics

Diagnostics are background/debounced rather than part of the keystroke critical path.

On open and every accepted change:

```text
update DocumentStore immediately
  ↓
advance diagnostics generation
  ↓
cancel/replace previous debounce timer
  ↓
~300 ms idle
  ↓
refresh targeted stale dependencies/config
  ↓
getSyntacticDiagnostics(file)
getSemanticDiagnostics(file)
  ↓
adapt spans/category/code/message
  ↓
publishDiagnostics(providerId, publication)
```

Do not call `getSuggestionDiagnostics()` in this MVP.

TypeScript diagnostic mapping:

- error → `error`;
- warning → `warning`;
- suggestion/message, if encountered through the used APIs → `information`;
- `source` → `typescript`;
- numeric TypeScript code → protocol string `code`.

Flatten TypeScript diagnostic message chains into bounded readable messages without losing the primary error text.
Each open document has a monotonically increasing diagnostics generation separate from the Orca document version. A completed calculation publishes only if both the generation and current document version still match.

When a file becomes clean, publish an explicit empty diagnostics array for the current document/version so Monaco removes the markers.

Syntax example:

```ts
const x =
```

must produce a TypeScript syntax error.

Semantic example:

```ts
const x: number = 'hello'
```

must produce a TypeScript type error. Changing it to `const x: number = 1` must clear the diagnostic after the debounce cycle.

## 13. Dependency and project invalidation

Open-document edits invalidate their own script immediately.

Before background diagnostics/project refresh, batch `statFiles` calls for tracked disk-backed dependencies whose freshness window has expired.

When `mtimeMs` or `byteLength` changes:

1. reread only the changed file;
2. replace its cached snapshot;
3. increment that file's script version;
4. increment the owning project version;
5. schedule diagnostics for every open document in that `TypeScriptProject`.

A changed dependency must therefore affect importing documents without recreating the Language Service.

If `tsconfig.json`, `jsconfig.json`, a resolved extended config, or resolution-relevant package metadata changes, rebuild/re-resolve only the affected project boundary.

### 13.1 No global polling loop

The MVP does not continuously crawl every file in every project.

Freshness checks are targeted and piggyback on editor activity/diagnostics scheduling. This is sufficient to prove dependent-file invalidation without introducing a second public file-watch protocol in the same PR.

If measurements show that targeted stamp refresh is insufficient for idle externally-edited projects, a future Editor/Workspace Provider extension can add push invalidation/watch subscriptions.

## 14. Lifecycle and cleanup

When the last open document belonging to a `TypeScriptProject` closes, the project may remain warm only for a short bounded idle period if its plugin/worktree lease still exists because another project in that worktree remains active.

When the plugin loses its last editor-worktree lease for a worktree:

- cancel diagnostics timers for that worktree;
- dispose TypeScript Language Service instances for that worktree;
- clear project VFS/cache state;
- clear negative module-resolution entries;
- drop any pending hydration jobs;
- prevent new workspace host reads.

Plugin disable, worker shutdown, or host disposal must reach the same terminal state.

Disposing the plugin must not affect Monaco's own ability to edit the open document.

## 15. Performance requirements

The editor must never run project hydration or diagnostics work synchronously on every keystroke.

Required scheduling rules:

- incremental overlay update: immediate;
- completion: on-demand and latency-sensitive;
- diagnostics: ~300 ms debounce after latest change;
- dependency stat/read refresh: batched with background diagnostics/project work;
- structural project rebuild: debounced/deduplicated;
- no Language Service recreation for ordinary edits.
Target metric:

```text
warm completion P95 < 100 ms
```

Measure on a deterministic small/medium local fixture after project warm-up. The performance test should record distribution data across repeated requests rather than assert against one cold call.

The CI/local gate must use enough tolerance to detect regressions without becoming a flaky microbenchmark. The PR evidence should report the measured P50/P95 even if only a broader non-regression threshold is automated.

## 16. Plugin manifest

The bundled first-party plugin declares:

```json
{
  "publisher": "stablyai",
  "name": "orca-typescript",
  "pluginApi": 1,
  "main": "worker.mjs",
  "capabilities": [
    { "kind": "editor:languageService" },
    { "kind": "workspace:readFiles" }
  ],
  "contributes": {
    "editorProviders": [
      {
        "id": "typescript",
        "languages": ["typescript", "javascript", "typescriptreact", "javascriptreact"],
        "features": ["completion", "diagnostics"]
      }
    ]
  }
}
```

Normal engine/version fields required by the existing manifest remain present in the real file.

## 17. Source and packaged layout

Keep authoring source separate from immutable bundled plugin bytes.

Recommended source layout:

```text
plugins/orca-typescript/
  src/
    document-store.ts
    workspace-file-cache.ts
    project-resolver.ts
    project-manager.ts
    typescript-project.ts
    completion-adapter.ts
    diagnostics-scheduler.ts
    worker.ts
  tests/
  build.mjs
  orca-plugin.json
```

Generated bundled layout:

```text
resources/plugins/launch/stablyai.orca-typescript/
  orca-plugin.json
  worker.mjs
  lib/
    lib.d.ts
    lib.es5.d.ts
    ...complete TypeScript 6 lib*.d.ts set...
```

The exact source-file split may change to satisfy max-lines and cohesion, but the responsibility boundaries above must remain visible and independently testable.

The generated tree is a normal Orca plugin install input, not special-cased editor core code.

The authoring source under `plugins/orca-typescript/` must be excluded from Electron application packaging so it is not duplicated in `app.asar`. Only the verified generated tree under `resources/plugins/launch/stablyai.orca-typescript/` is a runtime plugin resource.

### 17.1 Build requirements

The plugin build must be deterministic from repository inputs and must not execute package-manager installation as part of plugin installation.

Build checks:

- `worker.mjs` contains/bundles the required TypeScript 6 runtime;
- no runtime dependency on Orca root `node_modules`;
- the complete TypeScript 6 standard-library `lib*.d.ts` declaration set is copied;
- no symlinks in generated plugin content;
- generated manifest parses through Orca's existing manifest schema;
- generated plugin tree hashes consistently;
- total generated tree stays below the existing 50 MiB plugin-content limit;
- worker entry stays below its existing artifact limit;
- generated source does not import `node:fs`, `node:fs/promises`, or other direct workspace filesystem escape hatches.

The build/test pipeline should verify generated resources without forcing ordinary unit tests to rewrite committed artifacts unexpectedly.

### 17.2 Bundled plugin index

`stablyai.orca-typescript` is a first-party bundled plugin and therefore participates in the existing `resources/plugins/launch/bundled-plugins.json` integrity/index flow.

The release index must contain the generated plugin content hash. Existing bundled-bootstrap validation remains the authority; do not create a parallel plugin-loading path.

If bundled plugins require explicit default enablement/consent behavior, use the existing first-party plugin bootstrap/consent model rather than bypassing capability review for this plugin.

## 18. JavaScript / JSX behavior

Language mapping:

```text
typescript      → .ts
typescriptreact → .tsx
javascript      → .js
javascriptreact → .jsx
```

Configured projects use the real `tsconfig.json` / `jsconfig.json` settings.

In inferred JavaScript projects, completions still benefit from TypeScript inference and JSDoc even when semantic checking is not globally enabled.

Syntax diagnostics remain available for JavaScript. Semantic JS diagnostics follow TypeScript's configured / `@ts-check` behavior.

TSX/JSX tests must prove both parsing and at least one completion path inside a component/source file; merely accepting the extension is insufficient.

## 19. Failure handling

A language-service failure must degrade the plugin, not the editor.

Rules:

- malformed config → log bounded error, use degraded/inferred behavior where safe;
- missing dependency → cache missing result, continue with partial project;
- oversized dependency → record explicit unavailable status, continue without truncation;
- workspace host unavailable → fail that hydration attempt and keep open-document intelligence where possible;
- TypeScript API exception → log provider-scoped error, return empty/no completion or diagnostics for that cycle;
- plugin worker crash → existing PluginWorkerController supervision applies;
- plugin disable/revoke → existing Editor Provider Router clears diagnostics/providers and editor remains usable.

Do not surface raw host filesystem paths in plugin-facing errors where Orca already treats them as sensitive implementation details.

Do not retry failures indefinitely. Hydration/config retries are triggered by subsequent relevant editor activity or freshness expiration.

## 20. TDD contract

Fundamental rule for this implementation:

> NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.

Every implementation slice begins by running a focused test that fails for the expected missing behavior, then implements the minimum code to make it pass, then refactors while green.

### 20.1 Required RED → GREEN slices

At minimum, implementation tests must prove:

1. `EditorDocumentOpen.relativePath` schema/transport/renderer population;
2. `workspace:readFiles` manifest capability validation and consent fingerprinting;
3. worker-only host method enforcement;
4. host path validation and traversal rejection;
5. editor-worktree lease acquisition/revocation;
6. leased local workspace directory/stat/read behavior;
7. remote/runtime filesystem routing contract without direct local path assumptions;
8. per-call path/count/byte limits and no silent truncation;
9. basic inferred object-property completion;
10. typed interface/property completion;
11. local-symbol completion;
12. cross-file project completion/import resolution;
13. TypeScript auto-import candidate visibility when available;
14. syntax diagnostic;
15. semantic diagnostic;
16. corrected semantic diagnostic publishes an empty diagnostic set;
17. incremental edit updates snapshot without recreating Language Service;
18. close removes overlay and restores disk snapshot when present;
19. close removes temporary script when no disk file exists;
20. `tsconfig.json` project options/root files;
21. `jsconfig.json` JavaScript behavior;
22. TSX completion/parsing;
23. JSX completion/parsing;
24. two tsconfig projects in one worktree remain isolated;
25. dependency stamp/content change invalidates importing open documents;
26. config change rebuilds only affected project;
27. diagnostics debounce collapses rapid edits;
28. stale diagnostics generation cannot publish;
29. aborted/stale completion cannot publish;
30. losing final lease disposes project/cache state;
31. generated plugin artifact is self-contained and within content limits.

### 20.2 Test layers

Prefer the cheapest deterministic layer that proves each contract:

```text
shared schema/capability tests
  ↓
main host API + lease/security tests
  ↓
plugin pure-unit tests
  ↓
plugin worker integration tests
  ↓
Editor Provider integration tests
  ↓
Electron Monaco E2E
```

Do not use the Electron E2E to prove every TypeScript edge case. It proves the vertical wiring once; language/project behavior belongs in deterministic unit/integration tests.

Tests must assert that a RED failure is caused by the missing behavior, not by fixture setup, missing generated artifacts, or unrelated baseline failures.

## 21. Main/runtime integration seam

Extend the structural plugin runtime delegate with narrowly named read operations rather than handing plugins the runtime service object.

Conceptually the binding needs host-side operations equivalent to:

```ts
readPluginWorkspaceDirectory(worktreeId, relativePath)
statPluginWorkspaceFiles(worktreeId, relativePaths)
readPluginWorkspaceFiles(worktreeId, relativePaths, limits)
```

These methods resolve `id:${worktreeId}` through Orca runtime authority and then use the same local/remote filesystem provider routing used by existing runtime file commands.

They are internal host services, not additional public plugin methods. Public plugin calls remain the three `workspace.*` methods defined above.

Existing mobile-preview 512 KiB limits must not be reused accidentally if doing so would silently undercut the explicit 4 MiB plugin source-file contract. The new read path needs its own bounded text-source semantics while reusing authority/provider routing.

## 22. Electron E2E

Create a real temporary TypeScript project in the active E2E worktree, for example:

```text
tsconfig.json
src/user.ts
src/example.ts
```

The test flow:

1. enable plugin system;
2. install or activate the real `stablyai.orca-typescript` plugin artifact;
3. approve the exact capability fingerprint;
4. open `src/example.ts` in Monaco;
5. enter an incomplete object property expression;
6. trigger `ControlOrMeta+Space` as appropriate for the platform/harness;
7. assert a real TypeScript Language Service completion is visible;
8. introduce a semantic type error;
9. assert a Monaco squiggly is visible;
10. correct the type error;
11. assert the squiggly disappears;
12. disable the plugin;
13. trigger completion again and assert the TypeScript-provider suggestion is absent;
14. assert Monaco remains visible and editable.

The E2E must not contain a hardcoded completion implementation in the plugin. The completion must originate from the bundled TypeScript Language Service.

Temporary project files and installed test plugin state must be cleaned in `finally` even when assertions fail.

## 23. Verification scope

Before merge, run the focused feature suite and the same quality surfaces used by the Editor Provider API PR where relevant:

- all changed/focused Vitest files;
- complete typecheck;
- changed-code quality checks;
- type-aware quality checks;
- React Doctor if renderer React code changes materially;
- reliability gates;
- max-lines ratchet;
- plugin artifact/integrity verification;
- the dedicated Electron TypeScript-provider E2E.
A full `pnpm test` run may still be used as broad evidence, but known unrelated baseline failures must not be "fixed" by this PR. Any newly observed failure must be classified against the feature branch and the base commit before changing unrelated subsystems.

The previous Editor Provider API verification established unrelated baseline/ambient failures in areas such as rate-limit PTY settle tests, i18n catalog drift, shell recipes, real Claude binaries, release checkout, and cross-version harness/tag behavior. This PR must not absorb those areas unless a new failing test proves direct causality.

## 24. Performance evidence

Add a deterministic completion benchmark/contract fixture representing a small-to-medium TypeScript project with multiple source files and a configured project.

Warm the project before measuring. Execute enough completion requests to report at least:

- sample count;
- P50;
- P95;
- maximum observed duration.

Target warm P95 is below 100 ms on the development/reference machine for this initial PR.

If the automated environment is too variable for a strict 100 ms gate, preserve the target as reported PR evidence and use a looser automated catastrophic-regression threshold. Do not weaken the product target itself to match noisy CI.

## 25. Security invariants

The implementation is unacceptable if any of these become false:

1. a plugin without `editor:languageService` cannot register/use the provider;
2. a plugin without `workspace:readFiles` cannot read workspace source files;
3. a plugin cannot use the file API for a worktree without an active router-derived lease;
4. panels cannot call the source file methods;
5. relative-path traversal cannot escape the leased worktree;
6. source contents are never silently truncated;
7. `orca-typescript` does not read repositories with direct `node:fs` calls;
8. plugins remain outside renderer/Monaco/React execution;
9. disabling the plugin removes its editor intelligence without destabilizing Monaco;
10. Monaco native TS/JS diagnostics remain disabled.

## 26. Explicit non-goals

This PR does not implement:

- generic LSP transport;
- external language-server process spawning;
- `process:exec` for language tooling;
- hover;
- go-to-definition;
- references;
- rename;
- signature help;
- code actions;
- formatting;
- semantic tokens;
- inlay hints;
- full VS Code extension compatibility;
- re-enabling Monaco TypeScript diagnostics;
- arbitrary plugin filesystem access;
- a global workspace watcher protocol;
- automatic application of TypeScript additional import edits.

Do not expand scope to these features unless a blocking implementation fact proves the approved MVP cannot function without one of them. If that occurs, stop and re-enter design review rather than smuggling the feature into implementation.

## 27. Acceptance criteria

The PR is functionally complete only when all of the following are true:

- a bundled `stablyai.orca-typescript` plugin registers through the existing Editor Provider API;
- its runtime uses TypeScript 6 programmatic Language Service APIs while Orca core remains on TypeScript 7;
- workspace reads require the new capability and an active editor-worktree lease;
- `.ts`, `.tsx`, `.js`, and `.jsx` are supported;
- real inferred and typed completions work;
- cross-file/project completions work;
- tsconfig/jsconfig isolation works across multiple projects;
- syntax and semantic diagnostics publish and clear correctly;
- incremental changes do not recreate Language Service instances;
- dependent-file changes invalidate affected open documents;
- the plugin artifact is self-contained and within Orca plugin limits;
- the Electron E2E proves completion, diagnostic, correction, disable, and editor survival;
- focused tests/typecheck/quality/reliability gates are green apart from independently proven baseline failures.

## 28. Implementation order implied by the design

The implementation plan should preserve dependency order rather than beginning with the TypeScript worker in isolation:

```text
relativePath protocol support
  ↓
workspace:readFiles capability + host schemas
  ↓
router-derived worktree leases
  ↓
runtime/provider-backed workspace read services
  ↓
plugin build skeleton + TS6 dependency
  ↓
DocumentStore + WorkspaceFileCache
  ↓
ProjectResolver + ProjectManager
  ↓
TypeScriptProject LanguageServiceHost
  ↓
completions
  ↓
diagnostics
  ↓
dependency/config invalidation
  ↓
bundled artifact/index
  ↓
Electron E2E + performance evidence
```

Every arrow denotes a testable contract boundary. The later layer must not be implemented by bypassing an earlier incomplete boundary.

## 29. Roadmap after this PR

If this MVP demonstrates good IDE quality and acceptable latency, the next planned work remains:

1. extend Editor Provider API with hover, definition, references, rename, signature help, and code actions;
2. introduce a safe service/capability for external language-server processes;
3. implement a generic Editor Provider API ↔ LSP adapter plugin;
4. add language plugins such as rust-analyzer, gopls, pyright, and clangd.

`orca-typescript` is deliberately the smallest real language-service proof before committing Orca to a generic LSP architecture.
