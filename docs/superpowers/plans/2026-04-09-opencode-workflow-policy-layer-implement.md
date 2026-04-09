# OpenCode Workflow Policy Layer Execution Packet

## Goal
Implement a minimal Workflow Policy Layer in `opencode-bridge` so callback-driven isolated continuations can advance multi-step workflows automatically across multiple OpenCode lanes.

## Approved design source
- `docs/superpowers/specs/2026-04-09-opencode-workflow-policy-layer-design.md`

## Plan source
- `docs/superpowers/plans/2026-04-09-opencode-workflow-policy-layer-implementation-plan.md`
- `docs/superpowers/plans/2026-04-09-opencode-workflow-policy-layer-tasks.md`

## Scope
1. workflow state + step intent contract
2. intent→lane resolution
3. callback outcome -> policy transition
4. isolated next-step launch from callback continuation
5. observability/status additions
6. tests and docs updates

## Constraints
- Keep first implementation minimal and additive
- Do not build a heavyweight workflow DSL yet
- Preserve existing callback authority model
- Fail fast on unresolved lane or invalid transition
- Avoid duplicate callback double-launch

## Acceptance criteria
- workflow state exists in run artifact / runtime contract
- intent→lane resolution works with explicit/project/default precedence
- callback can automatically launch next isolated step
- status surfaces show workflow + step + lane + next action
- at least one multi-step workflow smoke test passes

## Suggested execution order
1. contracts/types
2. intent→lane resolver
3. workflow policy resolver
4. callback continuation integration
5. observability/status
6. tests
7. docs/skill update

## Validation
- run test suite
- run targeted callback/workflow policy tests
- confirm multi-step isolated continuation behavior in smoke test
