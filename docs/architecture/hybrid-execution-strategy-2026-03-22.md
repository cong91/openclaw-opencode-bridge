# Hybrid execution strategy for opencode-bridge

## Decision
From Step 2 onward, `opencode-bridge` adopts a hybrid execution strategy:

- **CLI-direct** for lightweight execution
- **serve/plugin mode** for canonical callback, event-driven flows, observability, and multi-project-safe control plane

## Why hybrid
### CLI-direct strengths
- Lower overhead for one-shot tasks
- No long-lived serve lifecycle to manage
- Simpler execution path for single-lane coding or short-lived automation

### serve/plugin mode strengths
- Stable per-project control plane
- OpenCode-side plugin can observe internal session lifecycle events
- Better callback architecture for terminal state notifications
- Better fit for multi-project routing and runtime introspection

## Routing guidance
### Prefer CLI-direct when
- task is lightweight or one-shot
- callback is not the main requirement
- no need for long-lived project server state
- no need for OpenCode-side event hooks

### Prefer serve/plugin mode when
- callback correctness matters
- event-driven lifecycle handling is required
- multi-project safety matters
- observability and session/event introspection are important
- multiple tasks may reuse the same project-bound runtime

## Canonical position
`serve/plugin mode` remains the canonical path for bridge-level callback architecture.

`CLI-direct` is an optimization lane, not the primary architecture for lifecycle-driven callback control.

## Carry-forward note
Step 1 proved that OpenClaw-side orchestration + OpenCode-side plugin callback is functionally viable. Remaining callback-once reproducibility is considered hardening, not a blocker for proceeding with hybrid architecture work.
