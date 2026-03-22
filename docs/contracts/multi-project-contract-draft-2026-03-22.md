# Multi-project contract draft for opencode-bridge

## Goal
Make callback routing and runtime reuse safe when OpenCode is running multiple projects.

## Core invariant
A bridge execution must never silently run against the wrong project root.

## Required identity fields
### Project-level
- `project_id`
- `repo_root`
- `opencode_server_url`

### Run-level
- `run_id`
- `task_id`
- `requested_agent_id`
- `resolved_agent_id`
- `callback_target_session_key`
- `callback_target_session_id` (optional but preferred)

## Session tagging
Bridge-created OpenCode sessions should include a recoverable title tag or metadata with at least:
- `runId=<...>`
- `taskId=<...>`
- `requested=<...>`
- `resolved=<...>`
- `callbackSession=<...>`
- `callbackSessionId=<...>`

## Dedupe key
### OpenCode-side callback plugin
Canonical dedupe key:
- `sessionId|runId`

### OpenClaw-side bridge run state
Canonical run identity:
- `project_id|run_id`

## Audit schema direction
### OpenCode-side audit
Should include:
- `event_type`
- `session_id`
- `run_id`
- `task_id`
- `callback_target_session_key`
- `status`
- `ok`
- `created_at`

### OpenClaw-side audit
Should include:
- `project_id`
- `run_id`
- `task_id`
- `requested_agent_id`
- `resolved_agent_id`
- `callback_target_session_key`
- `callback_status`
- `callback_ok`
- `created_at`

## Serve reuse rule
Serve reuse is allowed only when runtime introspection confirms:
- `directory === repo_root`

If this cannot be verified, bridge must fail closed or spawn a fresh serve bound to the correct repo root.
