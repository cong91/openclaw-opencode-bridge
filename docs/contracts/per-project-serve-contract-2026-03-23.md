# Per-project serve contract for `opencode-bridge`

Date: 2026-03-23
Status: draft-for-review
Intent: define the currently recommended default serve topology for the bridge

Related:
- Decision memo: `docs/packets/2026-03-23-serve-topology-decision-memo.md`
- Research plan: `docs/packets/2026-03-23-serve-topology-research-plan.md`
- Shared-serve candidate (archived): `docs/contracts/multi-project-shared-serve-contract-2026-03-23.md`

---

## 1. Chosen default

For `opencode-bridge`, the default serve topology is:
- **1 project = 1 default serve instance**

This is an **operating default**, not a claim that OpenCode is incapable of multi-project sessions on one serve.

The reason for this default is product fit and operational safety, not technical impossibility of other topologies.

---

## 2. Why this default was chosen

Per-project serve is the current default because it gives us the best balance of:
- callback correctness
- observability clarity
- operator mental-model simplicity
- easier debugging
- smaller failure blast radius

Compared with shared serve, this default better matches the current maturity and reliability needs of the bridge.

---

## 3. Core invariant

A bridge execution must never silently run, observe, summarize, or callback against the wrong project root or wrong origin session.

---

## 4. Default topology semantics

## 4.1 Serve ownership
Under the default mode, a serve is treated as the runtime endpoint dedicated to one project for bridge purposes.

This means the bridge may safely reason that:
- serve URL maps to one project binding in default mode
- `/path` and `/project/current` should align with that project
- project-level observability remains easier to interpret

## 4.2 Important caveat
This is a **bridge policy default**, not a universal truth of OpenCode.

If future advanced modes allow shared serve, they must be opt-in and must not weaken the safety guarantees of the default mode.

---

## 5. Canonical identity fields

## 5.1 Project-level
- `projectId`
- `repoRoot`
- `serverUrl`

## 5.2 Run-level
- `runId`
- `taskId`
- `requestedAgentId`
- `resolvedAgentId`
- `originSessionKey`
- `originSessionId?`
- `callbackTargetSessionKey`
- `callbackTargetSessionId?`

## 5.3 Session-level
- OpenCode `sessionId`
- tagged session title
- session `directory`

Even with per-project serve as default, run/session correlation remains required.

---

## 6. Serve reuse rule

Serve reuse is allowed by default only when the candidate serve is already bound to the same project/repo expected by the bridge.

If project binding cannot be confirmed confidently, the bridge should:
- fail closed, or
- spawn a fresh serve for that project

---

## 7. Callback contract

OpenCode-side plugin remains the terminal callback authority.

Callback metadata must still include:
- `kind = opencode.callback`
- `eventType`
- `runId`
- `taskId`
- `projectId?`
- `repoRoot`
- `requestedAgentId`
- `resolvedAgentId`
- `callbackTargetSessionKey`
- `callbackTargetSessionId?`
- `opencodeSessionId`
- `workflowId?`
- `stepId?`

Callback routing must always target the origin/caller session.

---

## 8. Observability contract

## 8.1 Default principle
Observability may use serve-level project alignment as a stronger default assumption than in shared-serve mode, but must still remain run/session-aware.

## 8.2 Why run/session correlation still matters
Even in per-project mode, correctness still depends on:
- correct run artifact lineage
- correct session resolution
- correct callback target correlation

This avoids accidental coupling to weak or stale server-level assumptions.

---

## 9. Registry direction

The current default model may keep a project-oriented serve registry, but should still distinguish:
- serve binding for the project
- run/session lineage for each execution

Suggested practical shape:
- serve registry keyed by project for default mode
- run artifacts keyed by run for observability and callback integrity

---

## 10. Future extension rule

Shared serve may be added later as an advanced, explicit policy mode if:
- observability hardening is sufficient
- multi-project same-serve tests are strong enough
- operator ergonomics remain acceptable

But the existence of that future option must not weaken the current default contract.

---

## 11. Summary

Chosen default for `opencode-bridge` today:
- **per-project serve**

Reason:
- safer and clearer for our workflow
- better operator ergonomics
- lower ambiguity for callback + observability correctness
