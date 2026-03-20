---
name: opencode-orchestration
description: Use when an outer agent already has planning/tracking artifacts and needs to hand off a file-driven execution packet to OpenCode/OpenCodeKit; this skill is a bridge into the execution lane, not a governance or Jira orchestration skill.
version: 1.0.0
owner: asm-operating-layer
---

# Opencode Orchestration

## Objective

Bridge an already-defined implementation packet into the OpenCode/OpenCodeKit execution lane with a strict boundary:

- **Outer agent = governance layer** (clarify if needed, create Jira bug/task or Epic+tasks, prepare/own artifacts, verify evidence, sync/close tracking)
- **ASM = retrieval backend** (context/project memory/coding packet)
- **OpenCode / OpenCodeKit = execution system** (read artifacts, orchestrate internally, implement, update execution checklist artifacts)

Default rule: for long workflows, prefer a file-driven SDD handoff. Outer agents should not manually micromanage OpenCode slice-by-slice.

Do not modify ASM core in this skill workflow.

## Hard Boundaries

This skill is a **handoff/bridge skill**, not a project orchestrator.

It must **not** redefine or absorb these responsibilities:

- Jira governance
- upfront planning ownership
- cross-functional governance orchestration
- outer-agent verification/closure

It exists only to pass a clean execution packet into OpenCode/OpenCodeKit and preserve execution-lane boundaries.

---

## Trigger Rules

Activate this skill when one of the following is true:

1. The outer agent already produced execution artifacts and must hand off implementation to OpenCode/OpenCodeKit.
2. The workflow is long enough that execution should be file-driven instead of manual outer-agent slice coordination.
3. A structured execution packet is needed across `scrum`, `fullstack`, `assistant`, `creator`.
4. There is real coordination need across multiple coding lanes inside the execution system.

Do not use this skill for research-only tasks that do not involve code edits.
Do not use this skill for:

- Jira creation/updates as the primary job
- design clarification or planning ownership
- `single-lane coding` with no need for packetized handoff
- small follow-up coding work
- routine coding tasks that OpenCode can execute directly without coordination overhead

---

## Standard Workflow Placement

Canonical file-driven flow:

1. `using-superpowers` selects the workflow
2. `brainstorming` clarifies/designs before planning when needed
3. `writing-plans` prepares plan + management gate + execution artifacts
4. outer agent automatically continues by creating/updating Jira, Epic/task breakdown, and artifacts when approval exists and no real blocker remains
5. `opencode-orchestration` hands the packet into OpenCode/OpenCodeKit execution
6. OpenCode/OpenCodeKit executes from artifacts as source of truth
7. outer agent verifies evidence via `verification-before-completion`, then syncs/closes Jira

## Pattern 3: Session/Server Mode

### Session roles

- **Outer Session**: maintains governance, tracking, artifacts, acceptance, and final verification.
- **Execution Sessions**: each coding task maps to one dedicated OpenCode/OpenCodeKit execution session.
- **Server State**: execution state lives in artifacts/checkpoints, not in ad-hoc chat memory.

### Task-to-session model

Each coding task must include:

- `task_id` (unique)
- `owner_agent` (executor)
- `session_key` (task-specific)
- `scope_claim` (intended files/modules)
- `state`: `queued | running | blocked_conflict | checkpoint_needed | done | failed | aborted`

Rules:

- 1 task ↔ 1 execution session
- Do not reuse an old session for a new task with a different primary scope
- The artifact packet is the source of truth for execution scope; outer governance owns lifecycle transitions

---

## Multi-agent applicability matrix

| Agent     | Primary role                      | Can own coding task? | Notes                                                                                    |
| --------- | --------------------------------- | -------------------: | ---------------------------------------------------------------------------------------- |
| scrum     | Outer governance + packet handoff |        Yes (limited) | Owns planning/tracking/handoff, should not micromanage OpenCode execution slice-by-slice |
| fullstack | Main coding executor              |                  Yes | Preferred execution owner for cross-layer/backend/frontend work                          |
| assistant | Support executor + synthesis      |                  Yes | Small fixes, glue code, verification checklists inside execution lane                    |
| creator   | UI/content implementation         |                  Yes | Preferred for UI copy/layout/asset pipeline                                              |

Rules:

- Only the outer governance layer should approve packet scope and acceptance before execution starts.
- Executors must not claim scope outside the coding packet.
- Executors do not read Jira directly; artifacts/packet are the execution source of truth.

---

## Serialized scheduling & conflict policy (MANDATORY)

### 1) Serialized by default

- By default, all coding tasks run **sequentially**.
- Parallel execution is allowed only when all conflict-safety conditions below are satisfied.

### 2) Conditions for parallel execution

Parallel is allowed only when orchestrator has evidence that:

1. `file_paths` do not overlap, **and**
2. `module_boundaries` do not share ripple-prone shared modules, **and**
3. No shared critical lock group is touched simultaneously: `package manifests`, `shared config`, `global types/contracts`, `build pipeline files`.

If any condition is uncertain => fall back to sequential.

### 3) Lock / release policy

When a task moves to `running`, it must acquire:

- `file_lock`: path-level lock
- `module_lock`: module/domain lock
- `shared_lock`: shared-critical lock group (if applicable)

Next tasks must wait if:

- path locks overlap, or
- modules have direct/shared dependency relations, or
- conflict risk has not been proven safe.

Release locks only when:

- task reports `done|failed|aborted` + checkpoint submitted,
- orchestrator confirms minimum artifact validity.

### 4) Ownership policy

- At any time, each file/module has **exactly one active owner task**.
- Ownership transfer requires explicit handoff (checkpoint + lock transfer).
- No "steal edit" on files currently locked by another task.

---

## Coding packet schema (executor input)

Use the following minimal JSON packet (can be generated by `project_coding_packet` when available):

Preferred artifact set around the packet:

- `specs.md` or equivalent approved design artifact
- `tasks.md` with executable checklist
- `implement.md` or packet JSON for execution instructions

OpenCode/OpenCodeKit should execute from these artifacts, not from Jira directly.

```json
{
  "packet_version": "v1",
  "task_id": "TASK-123",
  "workstream": "feature|bugfix|refactor|test",
  "owner_agent": "fullstack",
  "session_key": "coding:TASK-123",
  "objective": "Task objective",
  "scope": {
    "file_paths": ["src/a.ts", "src/b.ts"],
    "module_boundaries": ["billing", "ui.checkout"],
    "out_of_scope": ["infra/", "asm core"]
  },
  "conflict_policy": {
    "mode": "sequential_default",
    "parallel_allowed": false,
    "required_locks": ["file:src/a.ts", "module:billing"]
  },
  "acceptance": ["AC1 ...", "AC2 ..."],
  "validation": {
    "commands": ["npm test -- ...", "npm run build -- ..."],
    "must_include": ["test evidence", "changed files"]
  },
  "checkpoint_plan": {
    "interval": "per milestone",
    "required_events": ["start", "mid", "done_or_blocked"]
  },
  "retry_abort": {
    "max_retries": 1,
    "abort_on": ["conflict_unresolved", "scope_drift", "missing_context"]
  }
}
```

---

## Checkpoint/reporting protocol

Executors must report at these milestones:

1. **START**: packet acknowledged + lock acquired
2. **MID**: progress + diff summary + risk/conflict updates
3. **END**: `done|failed|aborted` + evidence

Minimum report fields:

- `task_id`
- `state`
- `files_changed`
- `tests_run` + `results`
- `risks/blockers`
- `lock_release_request`

Outer governance may mark `done` only after END report includes all required fields and verification evidence is independently checked.

---

## Retry / Abort / Escalation rules

### Retry

- Default max retry is 1 for transient failures (flake/tool timeout).
- Retry must keep the same scope lock; no silent scope expansion.

### Abort

Abort immediately if:

- unresolved overlap conflict is detected,
- task drifts from objective,
- changes are required in `out_of_scope` (especially ASM core),
- required context is missing and cannot be inferred safely.

### Escalation

Escalate to orchestrator (`scrum`/owner session) when:

- lock conflict exceeds SLA,
- acceptance criteria conflict,
- ownership transfer/handoff is required,
- someone requests bypass of sequential-by-default policy.

---

## Handoff rules across scrum/fullstack/assistant/creator

### scrum -> fullstack

- Hand over packet/artifacts with explicit scope lock.
- Fullstack must not change AC unless outer governance approves.

### fullstack -> assistant

- Use handoff for verification/test split or small follow-up fixes.
- Lock transfer must be explicit at file/module level.

### fullstack -> creator

- Handoff only UI/content/assets within creator scope.
- Shared UI core overlap must be checked before lock release.

### assistant/creator -> scrum

- Submit END report + evidence + suggested next task.
- Scrum/outer agent verifies and decides Jira/task closure or next scheduling.

---

## A2A language policy

- Agent-to-agent payloads (`sessions_spawn.task`, `sessions_send.message`, checkpoint/handoff payloads) **must be in Vietnamese**.
- Skill documentation can be English; runtime A2A payload policy remains Vietnamese.

---

## Minimal runtime bridge (v0-min)

To avoid ad-hoc `exec opencode ...`, use standard entrypoint:

- `node scripts/opencode-coding-runner.mjs --workstream coding_execution ...`

Bridge rules:

- Accept only `workstream=coding_execution`.
- Other workstreams are rejected with exit code `2`.
- Runner must always emit metadata JSON (stdout + `--out` file) with at least:
  - `invocation.command/rendered`
  - `opencode.agent/model`
  - `process.exit_code`
  - `result.status/error`
  - `evidence.git_commit`

Suggested packet usage:

- `--packet <path-to-packet.json>` to auto-map `task_id`, `owner_agent`, `objective`.

## OpenCode Bridge usage (current team standard)

Current team workflow after planning is:

1. `using-superpowers`
2. `brainstorming` (khi cần làm rõ design/spec)
3. `writing-plans`
4. `execute`
5. `verification-before-completion`

Trong bước **execute**, nếu routing đi vào OpenCode lane thì phải ưu tiên dùng **`opencode-bridge`** / bridge contract hiện tại thay vì ad-hoc pattern cũ.

### Current implementation status (important)
Bridge hiện đã chứng minh được các capability cốt lõi:
- routing envelope build
- callback payload build
- callback execution thật về `/hooks/agent`
- status artifact persistence
- mini listener runner / SSE probe ở mức PoC
- runtime assumption: **1 project = 1 OpenCode serve instance**

### How to think about execution now
- **Do not** assume one shared `opencode serve` is safe for many projects.
- **Do** bind every coding task to:
  - `project_id`
  - `repo_root`
  - `opencode_server_url`
  - `task_id`
  - `run_id`
  - `agent_id`
  - `session_key`
- **Do** treat `/hooks/agent` as callback primary.
- **Do not** use `cron` or `group:sessions` as the callback mechanism.

### Practical guidance for agents
When handing off into OpenCode execution:
- mention the intended repo explicitly
- ensure the execution packet is file-driven
- ensure the repo binding uses `--dir <repo>` or an equivalent project-bound path
- prefer bridge-aware execution over free-form `opencode run` whenever the flow needs:
  - callback
  - task/run tracking
  - serve/session registry
  - multi-agent lane routing

### Mandatory reporting after execution handoff
Outer agents should report:
- whether the task was handed to OpenCode direct path or bridge path
- the packet/artifacts used
- the target project/repo
- whether callback tracking is expected through `opencode-bridge`

## Direct OpenCode invocation correctness (CRITICAL)

When using OpenCode directly via CLI, the invocation must load the intended project config correctly.

### 1) Always pass the repo with `--dir`

Use:

- `opencode run --dir /absolute/path/to/repo ...`

Do **not** put the repo path inside the prompt/message body and assume OpenCode will infer project config from that text.
That mistake causes OpenCode to run outside the intended project context and can silently use the wrong resolved model/agent defaults.

### 2) Verify resolved model by reading the run banner

When testing a direct run, inspect the first banner line:

- Example good: `> build · gpt-5.3-codex`
- If the banner shows a different model than expected, do not trust the agent alias/config until root cause is understood.

### 3) Distinguish config intent vs runtime reality

Check in this order:

1. `opencode debug config` — resolved config
2. `opencode debug agent <name>` — resolved agent definition
3. `opencode run --agent <name> --dir <repo> "..."` — actual runtime banner

The runtime banner is the final truth for what model actually executed.

### 4) When model/agent resolution is unreliable, force the model explicitly

For high-confidence execution, prefer explicit `--model` over assumed alias mapping.
Recommended fallback pattern:

- coding pass: `opencode run --dir <repo> --model proxy/gpt-5.3-codex "..."`
- review pass: `opencode run --dir <repo> --model proxy/claude-opus-4-6-thinking "..."`

### 5) Use `--agent` only for primary agents that actually resolve in runtime

Do not assume every named agent is runnable the same way in all contexts.
If `opencode run --agent <name>` falls back or ignores the intended model, treat that as a runtime/config problem and verify with `debug config`, `debug agent`, and explicit `--model`.

### 6) Known verified fact from VAT repo (2026-03-18)

In `/Users/mrcagents/Work/projects/VAT`:

- calling `opencode run --agent build "/Users/.../VAT" "..."` (repo path in message) produced the wrong runtime model behavior
- calling `opencode run --agent build --dir /Users/mrcagents/Work/projects/VAT "..."` correctly resolved and executed `build · gpt-5.3-codex`

Operational rule:

- **No OpenCode direct-run guidance is considered correct unless it uses `--dir` for repo binding or another verified equivalent supported by runtime docs.**

## Skill loading policy for OpenCode execution

### 1) Do not rely on keyword superstition

OpenCode skill usage should not be reduced to brittle keyword-trigger rules.
The correct mental model is:

- global skill library exists
- `opencode-agent-skills` discovers skills from global + project locations
- OpenCode may auto-suggest/load relevant skills from context
- orchestrators still decide when a workflow is important enough to be stated explicitly

### 2) Global plugin, local override

Recommended baseline:

- install `opencode-agent-skills` in the **global** OpenCode config
- keep shared reusable skills in the **global** skills directory
- allow project-local skills to live in the project overlay when repo-specific behavior is needed

Operationally:

- if a skill exists in both global and project-local scope with the same name, **project-local wins**
- therefore a global plugin still supports local project overrides correctly

### 3) Auto skill loading is useful, but not a replacement for orchestration intent

Use this rule of thumb:

- **simple / common / routine coding work** -> let OpenCode auto-discover and load relevant skills
- **important workflows with strict execution shape** -> state the workflow explicitly in the prompt/handoff packet

Examples of workflows that should usually be explicit:

- `verification-before-completion`
- `writing-plans`
- `subagent-driven-development`
- `frontend-design`
- any repo-specific local skill that materially changes execution behavior

### 4) Prompting policy

Do not force a literal `use_skill` string in every prompt.
Instead:

- write the task clearly
- mention the workflow/skill explicitly when it matters to execution quality
- let the plugin resolve local-vs-global skill precedence

Good:

- "Implement X, then follow verification-before-completion before claiming done"
- "Plan first using writing-plans, then execute"
- "Use the repo's local frontend-design guidance if applicable"

Bad:

- stuffing prompts with a mechanical list of skill names for every task
- depending purely on a single keyword to guarantee behavior

### 5) Known verified fact (2026-03-18)

`opencode-agent-skills` is appropriate as a **global baseline plugin**.
When installed globally, it can still discover and use **project-local skills**, and project-local skills of the same name can override global ones.

## OpenCode Bridge Operational Usage (current team standard)

This section explains how to use the current `opencode-bridge` plugin/runtime path in real work.

### What is currently true

The current bridge stack already proves these capabilities:
- routing envelope construction
- callback payload construction for `/hooks/agent`
- callback execution into OpenClaw hook ingress
- run-status artifact persistence
- SSE probe path
- `listen_once` / `listen_loop` baseline for event-driven execution
- per-project serve registry baseline
- serve spawn / reuse / shutdown / idle-check baseline

### What is **not** yet safe to assume

Do **not** assume all of the following are production-grade yet:
- fully autonomous long-running listener without further supervision
- fully hardened multi-agent production runtime manager
- complete serve fleet management with every edge case covered
- all future OpenCode events already normalized perfectly

Agents must describe these limits honestly and avoid over-claiming completion.

### Execution lane assumptions (MANDATORY)

1. **One project = one OpenCode serve instance**
   - Do not assume one shared serve is safe for multiple repos.
   - Always bind execution to a single project/repo root.

2. **Callback primary = `/hooks/agent`**
   - Do not use `cron`, `group:sessions`, or `/hooks/wake` as the primary callback path.
   - `/hooks/wake` is only an auxiliary/system wake path, not the main execution callback route.

3. **Session key convention**
   - Use the convention:
     - `hook:opencode:<agentId>:<taskId>`

4. **Routing envelope fields are mandatory in bridge-aware execution**
   - `task_id`
   - `run_id`
   - `agent_id`
   - `session_key`
   - `origin_session_key`
   - `project_id`
   - `repo_root`
   - `opencode_server_url`

### Bridge-aware checklist before handing work to OpenCode

Before handing a task into OpenCode lane, the outer agent must ensure:

- [ ] `writing-plans` (or equivalent approved execution artifact generation) is already done
- [ ] execution packet/artifacts exist and are the source of truth
- [ ] `project_id` is known
- [ ] `repo_root` is known
- [ ] `opencode_server_url` is known or can be resolved from the bridge registry
- [ ] `task_id` and `run_id` are assigned
- [ ] `agent_id` and `session_key` are explicit
- [ ] callback expectation is explicit (`/hooks/agent`)

If the agent cannot satisfy these items, it should not claim the bridge flow is ready.

### Tool-by-tool usage (current bridge tools)

Use these tools deliberately:

#### `opencode_status`
Use to inspect the current bridge contract, assumptions, registry-related config, and lifecycle model.

#### `opencode_resolve_project`
Use when you need to resolve which OpenCode serve should be used for a given:
- `projectId`
- `repoRoot`

#### `opencode_build_envelope`
Use when you are about to delegate a concrete task into OpenCode lane and need the canonical routing envelope.

#### `opencode_build_callback`
Use when mapping a known OpenCode event into a callback payload for OpenClaw.

#### `opencode_execute_callback`
Use when executing the callback into `/hooks/agent` for a payload that has already been built.

#### `opencode_probe_sse`
Use when verifying that OpenCode serve is alive and emitting SSE events.

#### `opencode_listen_once`
Use for a small, single-shot proof that the bridge can:
- read an event
- normalize it
- callback
- write artifact

#### `opencode_listen_loop`
Use for baseline runtime-ops experiments where repeated event consumption and lifecycle handling are needed.
Treat it as baseline runtime manager logic, not a production-perfect daemon.

#### `opencode_run_status`
Use to inspect the artifact state of a previously handled run.

#### `opencode_callback_from_event`
Use when you already have a raw event and want to test the `normalize -> callback -> artifact` path directly.

#### `opencode_check_hook_policy`
Use to validate whether the current hook policy is compatible with the intended `agentId` and `sessionKey`.

#### `opencode_evaluate_lifecycle`
Use to evaluate lifecycle state from:
- last event kind
- last event timestamp
- soft/hard stall thresholds

#### `opencode_registry_get`
Use to read the current project -> serve registry.

#### `opencode_registry_upsert`
Use to create/update project -> serve registry entries.

#### `opencode_registry_cleanup`
Use to normalize and clean invalid/incomplete registry entries.

#### `opencode_serve_spawn`
Use to spawn an OpenCode serve for a project with dynamic port allocation and registry update.

#### `opencode_serve_idle_check`
Use to evaluate whether a serve should be shut down based on idle timeout.

#### `opencode_serve_shutdown`
Use to mark a serve as stopped and send shutdown for a project serve entry.

### Recommended end-to-end bridge-aware flow

When a task must enter OpenCode execution lane, use this order:

1. Prepare/verify execution packet via the outer workflow (`using-superpowers` → `brainstorming` if needed → `writing-plans`)
2. Resolve project/server:
   - `opencode_resolve_project`
   - or spawn one via `opencode_serve_spawn`
3. Build routing envelope:
   - `opencode_build_envelope`
4. Verify serve/event path as needed:
   - `opencode_probe_sse`
   - `opencode_listen_once`
5. Build and/or execute callbacks:
   - `opencode_build_callback`
   - `opencode_execute_callback`
   - or `opencode_callback_from_event`
6. Check run artifact/status:
   - `opencode_run_status`
7. Only then proceed to outer verification:
   - `verification-before-completion`

### Reporting requirements

When handing work into OpenCode lane, the outer agent should report:
- whether it used direct OpenCode execution or bridge-aware execution
- which packet/artifact was used
- which `project_id` / `repo_root` / `opencode_server_url` was targeted
- whether callback tracking is expected through `opencode-bridge`

### Do / Don't

#### Do
- Do keep OpenCode execution project-bound.
- Do keep callback/session routing explicit.
- Do use `opencode-orchestration` when coordination or bridge semantics matter.
- Do use `verification-before-completion` before claiming completion.

#### Don’t
- Don’t use ad-hoc `opencode run` when the work needs callback, lifecycle tracking, or registry-aware execution.
- Don’t assume a single serve is multi-project-safe.
- Don’t assume bridge/runtime-manager features are production-perfect without verification.
- Don’t over-claim that the bridge is fully autonomous when only PoC/baseline behavior has been verified.

## Guardrails

- Do not modify ASM core while using this orchestration skill.
- Do not deploy production from this skill flow.
- Keep diffs minimal and within packet scope.
- Do not turn this skill into Jira governance, planning governance, or general project orchestration.
- Always verify before claiming completion.
