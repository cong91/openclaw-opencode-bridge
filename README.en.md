# openclaw-opencode-bridge

OpenClaw ↔ OpenCode bridge plugin for multi-agent orchestration, callback routing, SSE probing, and runtime-ops scaffolding.

## Goals
- Standardize callback flow from OpenCode back into OpenClaw via `/hooks/agent`
- Standardize `sessionKey` and `routing envelope`
- Support the operational model: **1 project = 1 OpenCode serve instance**
- Provide a foundation for:
  - SSE probe / listener
  - callback execution
  - run-status artifacts
  - serve registry / spawn / reuse / shutdown / idle evaluation

## npm package
```bash
openclaw plugins install @mrc2204/openclaw-opencode-bridge
```

## Repository structure
```text
openclaw-opencode-bridge/
├── openclaw.plugin.json
├── package.json
├── src/
│   └── index.ts
├── skills/
│   └── opencode-orchestration/
│       └── SKILL.md
└── README.md
```

## Bundled skill
This repository includes:
- `skills/opencode-orchestration/SKILL.md`

The bundled skill explains how to route execution into OpenCode using bridge-aware conventions rather than ad-hoc `opencode run` usage.

## Available tools
- `opencode_status`
- `opencode_resolve_project`
- `opencode_build_envelope`
- `opencode_build_callback`
- `opencode_probe_sse`
- `opencode_execute_callback`
- `opencode_run_status`
- `opencode_callback_from_event`
- `opencode_listen_once`
- `opencode_listen_loop`
- `opencode_check_hook_policy`
- `opencode_evaluate_lifecycle`
- `opencode_registry_get`
- `opencode_registry_upsert`
- `opencode_registry_cleanup`
- `opencode_serve_spawn`
- `opencode_serve_idle_check`
- `opencode_serve_shutdown`

## Current assumptions
- `1 project = 1 opencode serve instance`
- callback primary = `/hooks/agent`
- `sessionKey` convention = `hook:opencode:<agentId>:<taskId>`
- `opencode_server_url` is a practically required field in the routing envelope

## Current maturity
This plugin is currently at **runtime-ops scaffold + PoC-proven path** maturity:
- callback execution has been proven with real calls
- SSE probe has been proven
- mini listener runner has been proven
- run-status artifacts are real
- serve registry / spawn / reuse / shutdown / idle evaluation exist at baseline level

It should not yet be treated as production-perfect for every edge case.

## Example config
```json5
{
  plugins: {
    allow: ["opencode-bridge"],
    entries: {
      "opencode-bridge": {
        enabled: true,
        config: {
          opencodeServerUrl: "http://127.0.0.1:4096",
          hookBaseUrl: "http://127.0.0.1:18789",
          hookToken: "<OPENCLAW_HOOK_TOKEN>",
          projectRegistry: [
            {
              projectId: "agent-smart-memo",
              repoRoot: "/Users/me/Work/projects/agent-smart-memo",
              serverUrl: "http://127.0.0.1:4096",
              idleTimeoutMs: 900000
            }
          ]
        }
      }
    }
  }
}
```

## Local development
```bash
openclaw plugins install -l ~/Work/projects/opencode-bridge
```

## Notes
- Do not use `cron` or `group:sessions` as the primary callback mechanism.
- Do not assume one serve is multi-project-safe.
- Use `skills/opencode-orchestration` as the team workflow entrypoint for the execute lane.

## License
MIT
