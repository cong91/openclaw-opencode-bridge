# Wave 1 Audit — OpenCode Bridge Runtime Contract (2026-03-25)

## Purpose

Audit the current `opencode-bridge` runtime against the agreed target contract:

- one active shared serve
- many projects per serve
- attach-run as primary execution lane
- callback via `/hooks/agent`
- run artifact as source of truth
- sessionId/opencodeSessionId persisted early
- callback terminal reconciles artifact state and cleans attach-run PID
- observability resolves project-aware first, recency second

---

## Target Truth Model

### Serve truth
- `serve` is shared runtime infrastructure, not project identity.
- `serves.json` should keep only the active running serve.
- serve reuse should prefer active registry serve; if registry is empty but a live serve exists, adopt it.
- serve creation must be guarded by a spawn lock.

### Run truth
`runs/<id>.json` is the primary source of truth for execution.
Required fields:
- `runId`
- `taskId`
- `projectId`
- `repoRoot`
- `opencode_server_url`
- `executionLane`
- `attachRun.pid`
- `sessionId`
- `opencodeSessionId`
- `sessionResolvedAt`
- `sessionResolutionStrategy`
- `sessionResolutionPending`
- callback terminal fields (`callbackOk`, `callbackStatus`, `callbackBody`)
- attach-run cleanup fields (`cleaned`, `cleanedAt`, `killSignal`, `killResult`)

### Session truth
Session resolution order should be:
1. explicit session id
2. artifact sessionId / opencodeSessionId
3. callback/origin target session id
4. callback/origin target session key
5. project/repo-scoped filtering
6. recency/token scoring

### Callback truth
- canonical callback path: `/hooks/agent`
- callback terminal must reconcile artifact state
- callback terminal must kill attach-run PID
- `deliver=true` should enqueue visible ack and audit it clearly

### Registry truth
- `serves.json` = active-only serve registry
- `sessions.json` = supporting index only, not primary truth for execution or observability

---

## Component Inventory

## 1. Execution / Control Plane

### `spawnServeForProject` (`src/runtime.ts`)
Current role:
- choose active serve or spawn a new one
- now includes live-process adoption groundwork and spawn lock

Assessment:
- partially aligned
- active-only registry behavior exists
- spawn lock exists
- live-process adoption groundwork exists
- still needs stronger test coverage for adoption + concurrent requests

Status: **partial / needs hardening**

### `runAttachExecutionForEnvelope` (`src/runtime.ts`)
Current role:
- primary execution via `opencode run --attach`
- passes `--dir`, `--agent`, `--variant`, `--thinking`

Assessment:
- aligned with target contract
- lane explicitness and reasoning/visibility knobs now match CLI truth

Status: **correct**

### `startExecutionRun` (`src/runtime.ts`)
Current role:
- write initial run artifact
- run attach-run primary
- resolve and persist session id early
- patch artifact running state

Assessment:
- substantially aligned
- still reports `running` after spawn even before strong proof of long-lived progress; this is acceptable for now but remains a known observability caveat

Status: **mostly correct**

### callback ingress (`src/registrar.ts`)
Current role:
- parse callback
- reconcile artifact terminal state
- enqueue callback wrapper
- enqueue visible ack if `deliver=true`
- continuation handling
- kill attach-run pid after terminal callback

Assessment:
- strongly aligned with target contract
- callback terminal is now authority for artifact close-out and PID cleanup

Status: **correct**

---

## 2. State / Registry Files

### `serves.json`
Current role:
- active-only serve registry
- stopped serves removed on write

Assessment:
- aligned
- no longer suitable as history store, which is acceptable under current contract

Status: **correct**

### `sessions.json`
Current role:
- supporting index for current directory/session mapping

Assessment:
- legacy importance is too high in some code paths conceptually, but current runtime truth already shifted toward artifact + callback + project-aware resolution
- should be explicitly treated as secondary cache/index in docs and code comments

Status: **legacy-support / not primary truth**

### `runs/<id>.json`
Current role:
- primary run truth

Assessment:
- now much closer to the intended model
- session id persistence and callback reconciliation exist
- cleanup evidence for attach-run exists

Status: **correct direction / primary truth**

---

## 3. Observability Surfaces

### `opencode_run_status`
Current role:
- merge artifact + API snapshot + event summary

Assessment:
- now uses project-aware session resolution path
- still needs stronger trace UX because users/agents can misread `running` as proof of active work when the session may already be terminal or stale

Status: **functional but UX-insufficient**

### `opencode_run_events`
Current role:
- resolve session, collect SSE events, return normalized event records

Assessment:
- project-aware session resolution improved
- still lacks a compact correlation narrative for humans/operators

Status: **functional but sparse**

### `opencode_session_tail`
Current role:
- resolve session, read `/message` + optional `/diff`

Assessment:
- project-aware resolution improved
- still depends on users knowing which run/session they are chasing

Status: **functional but sparse**

### `opencode_process_audit`
Current role:
- classify serve and attach-run processes

Assessment:
- aligned with current runtime hygiene needs
- gives the first proper OS-level classification layer

Status: **correct**

### `opencode_process_cleanup`
Current role:
- dry-run/apply cleanup for orphan serve and orphan/stale attach-run

Assessment:
- aligned
- hardened against self-kill by ignoring `process.pid` / `process.ppid` and only matching true command prefixes

Status: **correct**

---

## 4. Skills / Prompt Contract

### `skills/opencode-orchestration/SKILL.md`
Current role:
- execution contract for outer agents

Assessment:
- now reflects:
  - attach-run primary
  - `--agent` lane selection
  - `--variant` reasoning effort
  - `--thinking` visibility
  - shared-serve observability rule
  - prompt tightening / anti-stall guidance

Status: **correct and synced (repo + workspace)**

---

## Drift / Legacy Findings

### Drift 1 — operators still infer state from artifact `running`
Problem:
- artifact can still be interpreted too literally before callback/reconciliation completes

Impact:
- humans/agents may think there is “no log” or “still running” when the real issue is insufficient trace UX

Action:
- wave 2/3 should tighten run status semantics or add stronger warnings

### Drift 2 — observability is technically improved but not operator-friendly
Problem:
- state is spread across artifact + audit + session + process surfaces

Impact:
- other agents say “nothing to audit” because no single surface explains the run holistically

Action:
- add unified trace surface in a later wave

### Drift 3 — `sessions.json` still exists and may be mentally overweighted
Problem:
- old mental model treats session registry as primary truth

Impact:
- misdiagnosis when session registry and artifact diverge

Action:
- explicitly demote `sessions.json` to supporting index only

---

## Wave Priorities

## Wave 2 — Runtime Alignment
Focus:
- remove remaining semantic drift between runtime truth and artifact truth
- tighten run status semantics around running/stalled/terminal/callback-cleaned
- ensure all callback terminal paths reconcile consistently

## Wave 3 — Observability Alignment
Focus:
- build a compact trace surface that explains a run end-to-end
- reduce operator dependence on grep across multiple files

## Wave 4 — Operator UX
Focus:
- add a single `trace_run` style tool/surface
- return artifact + session + callback + process classification + warnings in one response

---

## Immediate Recommendation

Do not patch randomly from here.
Use this audit as the contract baseline and implement the next wave in order:
1. runtime truth semantics
2. observability trace consolidation
3. operator UX polish

---

## Current Verdict

The bridge is no longer on the old `1 project = 1 serve` model, but parts of the operator/debug experience still behave as if they expect that world.

Execution/control-plane is largely aligned.
Observability/operator-plane is the next major gap.
