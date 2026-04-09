# Design: OpenCode Workflow Policy Layer for Multi-Agent Isolated Continuations

Date: 2026-04-09  
Project: `opencode-bridge`
Status: Draft for approval-backed design handoff

## 1. Purpose

Design a **Workflow Policy Layer** for `opencode-bridge` so OpenCode can be used as a true multi-agent execution runtime instead of mostly a single `build/fullstack` lane.

The target capability is:

- outer/governance agent prepares artifacts and launches a workflow
- bridge chooses the correct OpenCode execution lane for the current step
- OpenCode finishes the step
- OpenCode-side plugin sends canonical terminal callback
- bridge resumes in a new isolated continuation session
- policy decides the next step/lane automatically
- workflow continues until terminal notify/stop/escalate

The design must avoid forcing humans to micromanage `design -> plan -> build -> review -> verify` lane-by-lane manually.

---

## 2. Problem statement

Current bridge/runtime already has strong primitives:

- explicit envelope fields:
  - `requested_agent_id`
  - `resolved_agent_id`
  - `callback_target_session_key`
  - `callback_target_session_id`
- plugin-owned callback authority
- run artifact persistence
- continuation fields:
  - `workflowId`
  - `stepId`
  - `nextOnSuccess`
  - `nextOnFailure`
- project-aware session resolution
- callback-driven attach-run closeout and continuation wake-up

However, usage is still under-optimized:

1. outer agents frequently choose `fullstack/build` manually instead of using the bridge as a workflow engine
2. step sequencing is often manual rather than policy-driven
3. bridge can continue a task, but it does not yet have a first-class **workflow policy layer** that decides the next step from task semantics and callback outcomes
4. current orchestration is still too close to “launch a single run” instead of “run a software-delivery workflow with automatic isolated continuations”

This leads to lost leverage:

- too much human/manual lane selection
- limited use of planning/review/explore lanes
- weak multi-step orchestration ergonomics
- insufficient exploitation of isolated callback sessions as workflow transitions

---

## 3. Goals

### Primary goals

1. Introduce a **Workflow Policy Layer** on top of existing bridge primitives.
2. Separate **step intent** from **execution lane**.
3. Allow the bridge to choose the next OpenCode execution lane based on workflow policy, not only by manually supplied lane names.
4. Use callback-driven isolated continuation sessions as the canonical mechanism for multi-step workflow progression.
5. Improve OpenCode utilization across multiple lanes/agents rather than overusing one coding lane.

### Secondary goals

1. Preserve fail-fast routing and callback integrity.
2. Make workflow state inspectable through observability/run status.
3. Keep the first implementation minimal and additive rather than building a heavyweight orchestration engine immediately.

### Non-goals

1. Replacing Jira/beads/outer governance logic.
2. Building a generalized enterprise workflow engine.
3. Solving all approvals/human-in-the-loop policies in this first version.
4. Replacing the OpenCode-side plugin callback model.

---

## 4. Core design principle

### 4.1 From lane-centric orchestration to intent-centric orchestration

Today, orchestration often thinks in terms of:

- run lane `build`
- then run lane `review`
- then run lane `explore`

The proposed design changes the center of gravity to:

- step intent = `design`
- step intent = `plan`
- step intent = `implement`
- step intent = `review`
- step intent = `verify`
- step intent = `repair`
- step intent = `notify`

Then a **policy resolver** maps each step intent into the most appropriate execution lane.

This lets the workflow remain stable even if the set of available OpenCode agents changes later.

---

## 5. High-level architecture

## 5.1 Layers

### Layer A — Outer governance layer

Owned by outer agents (e.g. `scrum`, `assistant`).

Responsibilities:

- clarify
- create/update artifacts/spec/plan/beads/Jira
- decide workflow type and objective
- launch workflow into bridge
- verify final evidence
- close or continue governance tracking

### Layer B — Workflow Policy Layer

New design target inside `opencode-bridge`.

Responsibilities:

- decide next step intent
- map step intent to execution lane
- decide next transition on success/failure/stall
- decide whether to launch a new run, notify, stop, or escalate

### Layer C — OpenCode execution layer

Existing OpenCode runtime lanes.

Responsibilities:

- run a step in an isolated session
- produce code/review/exploration results
- emit terminal callback via OpenCode-side plugin

### Layer D — Callback continuation layer

Existing callback/hook lane, strengthened by workflow policy.

Responsibilities:

- receive terminal callback
- reconcile artifact state
- consult workflow policy
- launch next isolated run or notify the origin session

---

## 6. New concepts

## 6.1 Workflow type

A high-level category describing the kind of work.

Examples:

- `feature-delivery`
- `small-fix`
- `forensic-fix`
- `provider-integration`
- `review-only`
- `research-then-build`

Workflow type does **not** directly name an execution lane.
It selects a policy profile.

---

## 6.2 Step intent

A semantic label for the current phase of work.

Initial recommended set:

- `clarify`
- `design`
- `plan`
- `explore`
- `implement`
- `review`
- `verify`
- `repair`
- `summarize`
- `notify`
- `stop`
- `escalate`

Step intent is the main unit used by the policy layer.

---

## 6.3 Execution lane

The actual OpenCode agent/lane selected to execute a step.

Examples today may include:

- `build`
- `review`
- `explore`
- `plan`
- `fullstack`

The bridge should treat execution lanes as runtime-resolved implementation targets, not as the semantic source of truth.

---

## 6.4 Transition action

What the continuation layer should do after a callback.

Possible initial actions:

- `launch_run`
- `notify`
- `stop`
- `escalate`
- `none`

---

## 7. Data model proposal

## 7.1 Workflow envelope additions

Add a workflow-oriented structure persisted in run artifact and exposed in status surfaces.

```json
{
  "workflow": {
    "workflowId": "wf-123",
    "workflowType": "feature-delivery",
    "policyVersion": "2026-04-09-v1",
    "objective": "Implement provider multi-step onboarding",
    "artifacts": {
      "spec": "docs/.../spec.md",
      "plan": "docs/.../plan.md"
    },
    "currentStep": {
      "stepId": "step-implement-1",
      "intent": "implement",
      "executionLane": "build",
      "status": "running"
    }
  }
}
```

---

## 7.2 Transition result shape

A policy decision function should return something like:

```json
{
  "action": "launch_run",
  "nextStep": {
    "stepId": "step-review-1",
    "intent": "review",
    "executionLane": "review"
  },
  "reason": "implement_succeeded_review_required",
  "promptPacket": {
    "objective": "Review the previous implementation",
    "constraints": ["Focus only on changed files"],
    "acceptanceCriteria": ["No critical defects remain"]
  }
}
```

---

## 8. Policy engine behavior

## 8.1 Inputs to policy

The Workflow Policy Layer should use:

- workflow type
- current step intent
- callback event type
- previous step terminal state
- warnings/blockers/evidence summary
- optional project policy hints
- optional explicit override from outer agent

---

## 8.2 Outputs from policy

The Workflow Policy Layer should produce:

- next action
- next step intent
- chosen execution lane
- prompt packet for next run
- notify message if terminal

---

## 8.3 Example policy rules

### `feature-delivery`

- `design` success -> `plan`
- `plan` success -> `implement`
- `implement` success -> `review`
- `review` success -> `verify`
- `verify` success -> `notify`
- `review` failure -> `repair`
- `repair` success -> `review`

### `small-fix`

- `implement` success -> `review`
- `review` success -> `notify`
- `review` failure -> `repair`

### `forensic-fix`

- `explore` success -> `design`
- `design` success -> `implement`
- `implement` success -> `verify`
- `verify` success -> `notify`
- `explore` inconclusive -> `explore` or `escalate`

These are policy examples, not hardcoded final workflows.

---

## 9. Intent -> lane resolution

## 9.1 Why this layer matters

The same step intent may map to different lanes in different repos or different runtime setups.

Examples:

- `implement` -> `build` in one environment
- `implement` -> `fullstack` in another
- `review` -> `review`
- `plan` -> `plan`
- `explore` -> `explore`

This resolution should be explicit and observable.

---

## 9.2 Resolution strategy

Resolution order:

1. explicit workflow override
2. project-specific policy mapping
3. global default mapping
4. fail-fast if no valid lane is resolvable

Example global mapping:

- `design` -> `plan`
- `plan` -> `plan`
- `explore` -> `explore`
- `implement` -> `build`
- `review` -> `review`
- `verify` -> `review`
- `repair` -> `build`
- `notify` -> no OpenCode lane required

The exact lane names must remain configurable.

---

## 10. Callback-driven isolated continuation

## 10.1 Desired lifecycle

1. Outer agent launches workflow step A.
2. OpenCode execution lane runs in an isolated session.
3. Terminal callback arrives.
4. Bridge reconciles artifact.
5. Callback continuation session wakes.
6. Workflow policy decides next step.
7. Bridge launches isolated session for step B.
8. Repeat until terminal notify/stop/escalate.

This realizes the desired pattern:

- design -> callback -> isolated plan
- plan -> callback -> isolated build
- build -> callback -> isolated review/verify

without requiring outer-agent manual lane-by-lane micromanagement.

---

## 10.2 Why isolated continuation remains important

Using isolated sessions for each step preserves:

- traceability
- state separation
- step-specific prompts
- easier debugging
- cleaner failure recovery

The callback session should remain a lightweight policy/transition lane, not a place for long-running implementation itself.

---

## 11. Observability changes

Run status / observability surfaces should expose:

- workflow type
- current step intent
- current execution lane
- previous step outcome
- next planned step
- next action (`launch_run`, `notify`, etc.)
- whether callback continuity launched a new run

This lets outer agents and operators answer:

- What workflow am I in?
- Which phase just finished?
- Which lane ran it?
- What is the next planned step?
- Why did the bridge choose that lane?

---

## 12. Suggested implementation surfaces

Likely files to touch when implementing:

### Core types/contracts
- `src/types.ts`

### Runtime / run launch
- `src/runtime.ts`

### Callback + continuation control
- `src/registrar.ts`
- `src/hook-continuation.ts`
- `hooks/opencode-callback.js`

### Skill/documentation
- `skills/opencode-orchestration/SKILL.md`

### Tests
- `test/execution-callback-loop.test.ts`
- `test/runtime-integrity.test.ts`
- `test/session-callback-integrity.test.ts`
- new workflow-policy tests

---

## 13. Risks

### 13.1 Looping transitions

Incorrect policy may create endless cycles such as:
- review -> repair -> review -> repair forever

Mitigation:
- transition attempt counters
- max loop threshold
- terminal `escalate` action

### 13.2 Lane resolution ambiguity

If runtime lane names drift, policy may map to a lane that does not resolve.

Mitigation:
- explicit lane registry/config
- fail-fast on unresolved lane
- status surfaces show requested intent + resolved lane

### 13.3 Callback duplication / double-launch

Terminal callback may arrive more than once.

Mitigation:
- keep plugin dedupe
- continuation dedupe key per run + step transition

### 13.4 Over-engineering too early

Building a full workflow DSL too soon could slow progress.

Mitigation:
- first implement a minimal policy layer + transition engine
- defer rich DSL unless needed

---

## 14. Recommended rollout

### Phase 1 — Minimal Workflow Policy Layer

- introduce workflow state object
- introduce step intent abstraction
- add intent->lane resolver
- add simple transition resolver

### Phase 2 — Callback transition execution

- callback lane consults workflow policy
- launch next isolated run automatically on success/failure rules

### Phase 3 — Observability

- expose workflow/step/transition state in status surfaces

### Phase 4 — Optional richer workflow profiles

- add templated workflow profiles for common task classes
- consider richer conditional transitions only after the minimal layer proves stable

---

## 15. Recommended path forward

Recommended approach:

### **Workflow Policy Layer + Step Intents + Callback-driven isolated continuation**

This provides the highest leverage while staying close to what the bridge already supports today.

It avoids:
- over-reliance on one coding lane
- human micromanagement of every step
- rigid dependency on a fixed list of agent names as the semantic model

And it enables:
- automatic multi-step orchestration
- stronger use of multiple OpenCode lanes
- better exploitation of callback-driven continuation

---

## 16. Acceptance criteria for implementation phase

A first implementation should satisfy:

1. Outer agent can launch a workflow by workflow type + objective + artifacts.
2. Bridge records current step intent and resolved lane.
3. Terminal callback can advance the workflow automatically.
4. Next step runs in a new isolated session.
5. Status surfaces show workflow + step + lane + next action.
6. Unresolvable lane or invalid transition fails fast.
7. At least one 3-step workflow smoke test passes, e.g.:
   - design -> plan -> build
   or
   - implement -> review -> notify

---

## 17. Proposed next step

After approval of this design:

1. write a plan packet / implementation plan
2. define the minimal workflow state schema
3. implement the policy layer in small phases
4. add callback-chain integration tests before broader rollout
