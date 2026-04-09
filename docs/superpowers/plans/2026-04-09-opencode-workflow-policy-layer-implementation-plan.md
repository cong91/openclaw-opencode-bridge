# OpenCode Workflow Policy Layer Implementation Plan

> Default coding route: bridge-aware OpenCode execution via `opencode-orchestration`.
> Execution shape: `multi-lane coding`

**Goal:** Implement a minimal but real Workflow Policy Layer in `opencode-bridge` so callback-driven isolated continuations can automatically advance multi-step workflows across multiple OpenCode execution lanes without requiring the outer agent to micromanage each lane manually.

**Architecture:** Add a lightweight workflow state + step intent + intent→lane resolution + callback transition policy layer on top of the existing bridge/runtime/callback primitives. Preserve current bridge callback authority and run artifact model, and extend it with workflow-aware transitions rather than building a heavyweight orchestration engine immediately.

**Tech Stack:** TypeScript/JavaScript, OpenCode bridge runtime, callback hooks, run artifact persistence, test suite in `opencode-bridge`.

---

## 1. Scope summary

This implementation focuses on a minimal viable workflow policy layer:

1. introduce workflow state shape and step-intent semantics
2. introduce intent→lane resolution
3. introduce callback transition policy resolution
4. wire callback continuation to launch next isolated step when policy says so
5. expose workflow/step/next-action status in observability surfaces
6. add tests for callback-driven multi-step transitions

Out of scope for this first pass:

- full workflow DSL
- fan-out/fan-in graph orchestration
- human approval engine
- broad Jira integration changes

---

## 2. Source-of-truth artifacts

### Approved design artifact
- `docs/superpowers/specs/2026-04-09-opencode-workflow-policy-layer-design.md`

### This implementation plan
- `docs/superpowers/plans/2026-04-09-opencode-workflow-policy-layer-implementation-plan.md`

### Execution artifacts to prepare/use
- this plan file
- `docs/superpowers/plans/2026-04-09-opencode-workflow-policy-layer-tasks.md`
- `docs/superpowers/plans/2026-04-09-opencode-workflow-policy-layer-implement.md`
- beads mirror for this work item

---

## 3. Exact files likely to create/modify

### Core runtime / contracts
- Modify: `src/types.ts`
- Modify: `src/runtime.ts`
- Modify: `src/registrar.ts`
- Modify: `src/hook-continuation.ts`
- Modify: `src/callback-artifact-reconciliation.js` (only if needed for workflow state persistence)

### Hooks
- Modify: `hooks/opencode-callback.js`

### New workflow-policy modules
- Create: `src/workflow-policy.ts`
- Create: `src/step-intent-resolver.ts`
- Create: `src/workflow-state.ts` (if clearer than overloading existing runtime/types)

### Observability / status
- Modify: any run-status/status formatter surfaces used by bridge tooling

### Skills / docs
- Modify: `skills/opencode-orchestration/SKILL.md`
- Create/modify: docs if needed for workflow policy usage examples

### Tests
- Modify: `test/execution-callback-loop.test.ts`
- Modify: `test/runtime-integrity.test.ts`
- Modify: `test/session-callback-integrity.test.ts`
- Create: `test/workflow-policy.test.ts`
- Create: `test/intent-lane-resolution.test.ts`

---

## 4. Architecture / approach summary

## 4.1 Minimal workflow state

Extend run artifact / runtime state with:

- `workflowId`
- `workflowType`
- `policyVersion`
- `currentStep.stepId`
- `currentStep.intent`
- `currentStep.executionLane`
- `currentStep.status`
- `nextTransition` (optional summary)

This state must be sufficient for callback continuation to decide the next action.

## 4.2 Step intent abstraction

Initial supported intents:

- `design`
- `plan`
- `explore`
- `implement`
- `review`
- `verify`
- `repair`
- `notify`
- `stop`
- `escalate`

## 4.3 Intent→lane resolution

Implement configurable resolver with order:

1. explicit workflow override
2. project-specific mapping
3. global defaults
4. fail-fast if unresolvable

## 4.4 Callback transition policy

When a terminal callback arrives:

- read workflow state
- derive terminal outcome
- call workflow policy resolver
- decide one of:
  - `launch_run`
  - `notify`
  - `stop`
  - `escalate`
  - `none`

If `launch_run`, continuation launches the next isolated session using the resolved execution lane.

## 4.5 Observability

Update status surfaces so operators can see:

- workflow type
- current step intent
- current execution lane
- previous step terminal outcome
- next planned step / next action

---

## 5. Task breakdown

### Task 1: Define workflow state and step intent contracts

**Files:**
- Modify: `src/types.ts`
- Create: `src/workflow-state.ts` (if needed)
- Test: `test/workflow-policy.test.ts`

- [ ] Add minimal workflow state interfaces/types.
- [ ] Define allowed step intents and transition action types.
- [ ] Define serialization shape suitable for run artifacts.
- [ ] Add tests for workflow state normalization/validation.

### Task 2: Build intent→lane resolution

**Files:**
- Create: `src/step-intent-resolver.ts`
- Modify: `src/runtime.ts`
- Test: `test/intent-lane-resolution.test.ts`

- [ ] Implement default mapping from step intent to execution lane.
- [ ] Support explicit override + project-aware override.
- [ ] Fail fast when lane cannot be resolved.
- [ ] Add tests for resolution precedence and failure behavior.

### Task 3: Build minimal workflow policy resolver

**Files:**
- Create: `src/workflow-policy.ts`
- Modify: `src/runtime.ts`
- Test: `test/workflow-policy.test.ts`

- [ ] Define minimal workflow types and their transition rules.
- [ ] Implement resolver from callback outcome -> next action.
- [ ] Support `launch_run`, `notify`, `stop`, `escalate`.
- [ ] Add loop-avoidance / transition counter safeguards if feasible in first pass.

### Task 4: Wire callback-driven isolated continuation

**Files:**
- Modify: `src/hook-continuation.ts`
- Modify: `src/registrar.ts`
- Modify: `hooks/opencode-callback.js`
- Test: `test/execution-callback-loop.test.ts`
- Test: `test/session-callback-integrity.test.ts`

- [ ] Read workflow state during callback continuation.
- [ ] Call workflow policy resolver.
- [ ] Launch next isolated step when action=`launch_run`.
- [ ] Preserve callback routing/session integrity.
- [ ] Ensure duplicate callback does not double-launch.

### Task 5: Expose workflow observability

**Files:**
- Modify: run status surfaces / any relevant formatter module
- Test: `test/runtime-integrity.test.ts`

- [ ] Surface workflow type.
- [ ] Surface current step intent.
- [ ] Surface resolved lane.
- [ ] Surface next action / next planned step.
- [ ] Add status assertions in tests if practical.

### Task 6: Update skill/docs and examples

**Files:**
- Modify: `skills/opencode-orchestration/SKILL.md`
- Optional docs additions if needed

- [ ] Explain intent-centric workflow orchestration.
- [ ] Document how outer agents launch workflow types rather than micromanaging lanes.
- [ ] Document callback-driven isolated continuation model.

### Task 7: End-to-end smoke tests

**Files:**
- Modify/create tests as needed

- [ ] Add at least one 3-step workflow smoke test.
- [ ] Recommended smoke workflow:
  - `implement -> review -> notify`
  or
  - `design -> plan -> implement`
- [ ] Verify each step is launched as a separate isolated continuation/run.

---

## 6. Test strategy

### Unit tests
- workflow state normalization
- intent validation
- transition action validation
- intent→lane resolution precedence
- workflow policy transition mapping

### Integration tests
- callback completion triggers policy evaluation
- policy launches next isolated step
- duplicate callback does not double-launch
- unresolved lane fails fast

### Smoke tests
- at least one successful multi-step callback-driven workflow
- at least one failure/corrective path workflow (if feasible)

---

## 7. Verification commands

Exact commands may vary by repo script layout, but target verification should include:

```bash
npm test
```

Targeted runs if available:

```bash
npm test -- workflow-policy
npm test -- execution-callback-loop
npm test -- session-callback-integrity
```

If there is a bridge-specific verification entrypoint, include it in execution packet.

---

## 8. Execution shape classification

- **Execution shape:** `multi-lane coding`
- **Default route:** bridge-aware OpenCode execution via `opencode-orchestration`

Rationale:
- multiple modules and callback surfaces are involved
- tests + runtime + hooks + docs all need coordinated updates
- the feature itself is about orchestrating multiple lanes and isolated continuation behavior

---

## 9. Risks / rollback notes

### Risks
- callback double-launch
- infinite review/repair loops
- ambiguous lane resolution
- status/reporting confusion if workflow metadata drifts from artifact state

### Mitigations
- transition dedupe key
- transition counters / fail-fast escalation
- explicit lane resolution errors
- keep first pass minimal

### Rollback strategy
- feature-gate workflow policy if needed
- preserve current single-step behavior as baseline path when no workflow state exists
- ensure legacy direct launch path still works if workflow packet is absent

---

## 10. Epic / tracking note

This is long, multi-step orchestration work and should be treated as tracked architecture/runtime work rather than a trivial patch.
A bead mirror and execution packet are required before coding handoff is considered ready.

---

## 11. Handoff artifacts

The following artifacts are prepared / to be prepared for execution:

- Plan: `docs/superpowers/plans/2026-04-09-opencode-workflow-policy-layer-implementation-plan.md`
- Tasks: `docs/superpowers/plans/2026-04-09-opencode-workflow-policy-layer-tasks.md`
- Implement packet: `docs/superpowers/plans/2026-04-09-opencode-workflow-policy-layer-implement.md`
- Spec: `docs/superpowers/specs/2026-04-09-opencode-workflow-policy-layer-design.md`
- Bead mirror: required for execution handoff
