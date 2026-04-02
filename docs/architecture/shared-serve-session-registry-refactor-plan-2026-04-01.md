# Shared Serve + Multi-Session Refactor Patch Plan

Date: 2026-04-01
Status: Draft patch plan
Scope: `opencode-bridge`

## 1) Updated semantics agreed for this refactor

This refactor does **not** remove `serves.json`.

Instead, runtime state is split into two layers:

### `serves.json` = serve-level source of truth
Must continue to be updated whenever serve lifecycle changes, including:
- spawn / first start
- reuse
- adopt live process
- health refresh
- shutdown
- cleanup / idle stop
- unexpected stop detection

Expected role:
- reflect the real shared serve endpoint currently in use
- reflect correct runtime status of the serve process
- remain canonical for serve lifecycle tracking even if runtime converges to **1 shared serve -> multi project / multi session**

Typical fields:
- `serve_id`
- `opencode_server_url`
- `pid`
- `status`
- `last_event_at`
- `idle_timeout_ms`

### `sessions.json` = session-level mapping registry
Used to track:
- which session is attached to which serve
- which directory / project a session belongs to
- current session per directory semantics

Typical fields:
- `session_id`
- `serve_id`
- `opencode_server_url`
- `directory`
- `project_id`
- `session_title`
- `session_updated_at`
- `status`
- `is_current_for_directory`
- `updated_at`

## 2) Refactor goals

1. Remove dynamic/random port allocation from the main serve spawn flow.
2. Standardize runtime on the default `opencode serve` port.
3. Keep `serves.json` fully updated for serve lifecycle transitions.
4. Start writing real session state into `sessions.json` after successful session resolution.
5. Remove outdated wording/assumptions implying `1 project = 1 serve`.
6. Preserve backward compatibility where practical for old registry/process patterns.

---

## 3) File-by-file patch plan

## A. `src/runtime.ts`
This is the primary implementation file.

### A1. `allocatePort()`

#### Current behavior
- Allocates a random free port using `listen(0)`.

#### Planned change
- Remove this function from the main serve spawn flow.
- Preferred outcome: no runtime path relies on random port allocation for normal `opencode serve` startup.

#### Notes
- If other unrelated code still depends on it, keep temporarily but eliminate all serve spawn call sites.

---

### A2. `spawnServeForProject(...)`

#### Current behavior
- Still carries per-project naming/intent.
- Reuses existing running serve when found.
- May adopt a live process.
- Otherwise spawns `opencode serve --hostname 127.0.0.1 --port <random>`.

#### Planned change
Rework this into **shared serve resolution** semantics.

#### Recommended rename
- `resolveOrStartSharedServe(...)`
- or `ensureSharedServe(...)`

#### Detailed patch steps
1. Keep the reuse-first behavior.
2. Keep live-process adoption behavior.
3. Replace random-port spawn command with default-port/shared-serve startup:
   - preferred: `opencode serve`
   - acceptable if needed: `opencode serve --hostname 127.0.0.1`
4. Introduce a canonical default serve URL helper.
5. After spawn succeeds and health check passes, ensure `serves.json` is updated.

#### Required `serves.json` behavior
On each lifecycle transition below, registry must be updated:
- shared serve spawned
- existing serve reused
- live serve adopted
- health check confirmed / refreshed
- serve shutdown
- serve cleanup
- serve detected dead / stale

#### Expected effect
- shared serve becomes the actual runtime model
- `serves.json` remains canonical for serve lifecycle
- no more random per-run/per-project port churn

---

### A3. Add canonical helpers in `src/runtime.ts`

#### New helper: `getDefaultServePort()`
Purpose:
- return the canonical default port used by `opencode serve`
- centralize the port constant or config lookup

#### New helper: `getDefaultServeUrl()`
Purpose:
- build canonical serve URL from hostname + default port

#### New helper: `buildServeRegistryEntry(...)`
Purpose:
- centralize construction of `serves.json` entry payloads
- avoid scattered ad-hoc registry shaping across spawn/reuse/adopt/shutdown flows

#### New helper: `buildSessionRegistryEntryFromRun(...)`
Purpose:
- centralize session entry creation after run/session resolution

---

### A4. `listLiveOpencodeServeProcesses()`

#### Current behavior
- Process detection assumes `--port` is present.

#### Planned change
Support both old and new process styles:
- `opencode serve`
- `opencode serve --hostname 127.0.0.1`
- `opencode serve --port <n>`
- `opencode serve --hostname 127.0.0.1 --port <n>`

#### Detailed patch steps
1. Detect any command matching `opencode serve`.
2. If `--port` exists, parse it.
3. If `--port` does not exist, assign canonical default port.
4. Build canonical `opencode_server_url` from parsed or default port.
5. Return enough metadata for adopt/reuse/cleanup decisions.

#### Expected effect
- process audit/cleanup remains functional after dropping random-port startup
- backward compatibility with old serve processes stays intact

---

### A5. `upsertServeRegistry(...)`

#### Current behavior
- Already trends toward keeping one active serve entry.

#### Planned change
Keep `serves.json` focused on serve lifecycle state, not project ownership.

#### Detailed patch steps
1. Preserve or strengthen canonical single-active-serve behavior.
2. Normalize duplicate running entries when encountered.
3. Keep latest healthy shared serve entry as canonical.
4. Mark superseded or stale entries appropriately (`stopped`, `unknown`, etc.) or remove via cleanup policy.
5. Ensure writes happen whenever serve lifecycle changes.

#### Registry semantics after patch
`serves.json` should reflect reality of the shared serve:
- current URL
- current PID
- current status
- last event timestamp
- idle/cleanup metadata

This file must continue to move as serve state changes.

---

### A6. `readServeRegistry()`, `writeServeRegistryFile()`, normalization helpers

#### Planned change
Review normalization logic to ensure:
- old multi-port entries can still be read
- stale entries do not block shared serve reuse
- canonical active shared serve remains clear

#### Migration policy
If legacy state contains multiple entries from historical dynamic-port runs:
- preserve readable compatibility
- normalize toward one canonical active shared serve entry
- retain enough metadata for safe operator visibility during transition

---

### A7. `readSessionRegistry()`, `normalizeSessionRegistry()`, `writeSessionRegistryFile()`, `upsertSessionRegistry()`

#### Current behavior
- Helpers exist but are underused.

#### Planned change
Keep these helpers, but make them part of the normal execution path.

#### Detailed patch steps
1. Ensure one `current` session per directory.
2. When a newer session becomes current for a directory:
   - set new entry `is_current_for_directory = true`
   - unset previous current session for same directory
3. Ensure `updated_at` is always refreshed.
4. Ensure `session_updated_at` is recorded when known.

#### Expected effect
- `sessions.json` becomes live session mapping state rather than dormant scaffolding

---

### A8. `startExecutionRun(...)`

#### Priority
This is the most important session-registry patch.

#### Current behavior
- Starts attach-run execution
- resolves session
- writes run artifact
- but does not meaningfully update `sessions.json`

#### Planned change
After successful session resolution, immediately upsert into `sessions.json`.

#### Detailed patch steps
1. Resolve session as done today.
2. Build `SessionRegistryEntry` from run/session result.
3. Call `upsertSessionRegistry(...)`.
4. Continue writing run artifact as before.
5. If session registry write fails:
   - surface warning/log clearly
   - avoid crashing the entire run unless policy explicitly requires hard failure

#### Minimum fields to write
- `session_id`
- `serve_id`
- `opencode_server_url`
- `directory`
- `project_id` (if available)
- `session_title` (if available)
- `session_updated_at`
- `status`
- `is_current_for_directory = true`
- `updated_at`

#### Expected effect
- every real execution that resolves a session becomes visible in `sessions.json`

---

### A9. Serve lifecycle write points in runtime

#### Requirement
Review runtime code and ensure `serves.json` is updated at all serve lifecycle points.

#### Must-update events
- new serve successfully spawned
- existing serve reused for run
- live serve process adopted into registry
- health check success/failure affecting status
- serve shutdown initiated
- serve confirmed stopped
- idle timeout cleanup
- orphan/stale normalization

#### Expected effect
`serves.json` remains accurate even in shared-serve mode.

---

## B. `src/registrar.ts`
This file exposes tool/operator-facing entrypoints and wording.

### B1. `opencode_execute_task`

#### Planned change
Update wording and semantics so the tool no longer implies project-specific serve spawning.

#### Detailed patch steps
1. Keep project context for routing/metadata.
2. Resolve execution against shared serve semantics.
3. Ensure any serve lifecycle updates are persisted in `serves.json`.
4. Keep backward compatibility for inputs that still mention project serve context.

---

### B2. `opencode_status`

#### Current issue
Still communicates `1 project = 1 serve` assumption.

#### Planned change
Update status output to reflect:
- one shared serve can back multiple sessions/projects
- `serves.json` is canonical for serve lifecycle
- `sessions.json` is canonical for session mapping

#### Suggested status presentation
- shared serve URL
- serve status / PID / last event time
- known session count
- optional breakdown by directory/project if available

---

### B3. `opencode_process_cleanup`

#### Planned change
Update cleanup/audit command matching so it works for both:
- explicit `--port` legacy serve processes
- default-port shared serve processes without `--port`

#### Expected effect
Cleanup continues to work after runtime migration.

---

### B4. `opencode_registry_get`

#### Planned change
Return or display both registries clearly:
- serve registry (`serves.json` semantics)
- session registry (`sessions.json` semantics)

#### Output semantics
- serve registry = lifecycle / runtime endpoint truth
- session registry = session attachment truth

---

### B5. `opencode_serve_spawn`

#### Planned change
Maintain input compatibility, but implementation should ensure shared serve semantics.

#### Important note
Even if `project_id` is still accepted:
- it must not imply spawning a fresh random-port serve per project
- it may remain as context/logging metadata only

---

## C. `src/types.ts`

### Planned change
Review `ServeRegistryEntry` and `SessionRegistryEntry` to ensure they match the intended semantics.

#### For `ServeRegistryEntry`
Keep it focused on serve lifecycle:
- `serve_id`
- `opencode_server_url`
- `pid`
- `status`
- `last_event_at`
- `idle_timeout_ms`

#### For `SessionRegistryEntry`
Keep it focused on session mapping:
- `session_id`
- `serve_id`
- `opencode_server_url`
- `directory`
- `project_id?`
- `session_title?`
- `session_updated_at?`
- `status?`
- `is_current_for_directory?`
- `updated_at`

#### Optional additions
Only add fields like below if truly needed by runtime behavior:
- `origin_run_id?`
- `last_seen_at?`

Avoid schema bloat until required.

---

## D. `src/observability.ts`

### Planned change
Update operator-facing summaries to match the new split:
- `serves.json` = serve lifecycle reality
- `sessions.json` = session mapping reality

### Suggested operator hints
- current shared serve URL
- whether shared serve is healthy
- known session count
- current session per directory status if available

Remove outdated hints that assume many random project-bound ports are expected.

---

## E. `README.md`

### Planned change
Update runtime model description.

#### Replace outdated framing
From:
- `1 project = 1 serve`

To:
- shared serve capable of handling multiple sessions/projects
- serve lifecycle tracked in `serves.json`
- session mapping tracked in `sessions.json`

#### Must document
- role of `serves.json`
- role of `sessions.json`
- default-port runtime semantics
- backward compatibility expectations for older state

---

## F. Tests

### F1. Existing tests likely needing updates
At minimum review and adjust:
- `test/serve-registry-live-only.test.ts`
- `test/serve-reuse-adoption.test.ts`
- `test/observability-shared-serve-project-scope.test.ts`
- any test asserting spawn command contains `--port`
- any test assuming many distinct random-port serve URLs are part of normal runtime

---

### F2. New tests to add

#### `shared-serve-default-port.test.ts`
Verify:
- default shared serve startup no longer requires random `--port`
- canonical URL resolves from default port
- `serves.json` is updated on spawn/reuse

#### `process-audit-default-port.test.ts`
Verify:
- process discovery recognizes:
  - `opencode serve`
  - `opencode serve --hostname 127.0.0.1`
  - legacy `opencode serve --port <n>`

#### `serve-registry-lifecycle-updates.test.ts`
Verify `serves.json` updates correctly on:
- spawn
- reuse
- adopt
- shutdown
- cleanup
- stale/dead detection

#### `session-registry-upsert-on-run.test.ts`
Verify:
- after `startExecutionRun(...)` resolves session
- `sessions.json` gets a real entry
- entry links back to serve correctly

#### `session-registry-directory-switch.test.ts`
Verify:
- when a newer session for same directory appears
- previous entry loses `is_current_for_directory`
- new entry becomes current

#### `registry-migration-multi-port-to-shared.test.ts`
Verify:
- legacy multi-port serve entries can be normalized
- canonical active shared serve survives
- operator-facing state remains understandable

---

## 4) Implementation order

### Phase 1 — Shared serve runtime
1. Add default serve helpers.
2. Rework `spawnServeForProject(...)` into shared serve resolution/start.
3. Remove random-port dependency from normal startup.
4. Update process discovery for both legacy and default-port serve commands.

### Phase 2 — Correct serve registry lifecycle
5. Ensure all serve lifecycle transitions write correct state to `serves.json`.
6. Normalize stale/duplicate legacy entries safely.

### Phase 3 — Make session registry live
7. Patch `startExecutionRun(...)` to upsert `sessions.json`.
8. Finalize `current-for-directory` semantics.

### Phase 4 — Operator surface and docs
9. Update `registrar.ts` wording and tool semantics.
10. Update `observability.ts` summaries.
11. Update `README.md`.

### Phase 5 — Validation
12. Update existing tests.
13. Add new coverage for serve lifecycle + session registry.
14. Verify backward compatibility with legacy port-based registry/process states.

---

## 5) Acceptance criteria

This patch is complete only when all items below are true:

1. Normal runtime no longer depends on random-port serve startup.
2. Shared serve runs on canonical default port semantics.
3. `serves.json` is updated correctly for actual serve lifecycle events.
4. `serves.json` remains canonical even in single-serve multi-session mode.
5. Process audit/cleanup can detect both legacy `--port` and new default-port serve processes.
6. `sessions.json` is updated after successful session resolution.
7. `sessions.json` correctly tracks current session per directory.
8. Tooling/docs no longer incorrectly claim `1 project = 1 serve`.
9. Existing behavior remains compatible enough for live upgrade from historical state.

---

## 6) Key design guardrail

Do **not** collapse serve state and session state into one registry.

The intended model is:
- `serves.json` = serve lifecycle truth
- `sessions.json` = session attachment truth

Even if runtime converges to a single shared serve, both registries remain meaningful and both must be actively maintained.

---

## 7) Suggested next execution step

Execute implementation as a focused runtime patch with this order:
1. runtime helpers + shared serve startup
2. serve lifecycle writes to `serves.json`
3. session writes to `sessions.json`
4. tooling/docs wording cleanup
5. tests + migration validation

This keeps behavior-safe changes first and wording changes last.
