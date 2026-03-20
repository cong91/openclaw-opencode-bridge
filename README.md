# openclaw-opencode-bridge

> English README: [README.en.md](./README.en.md)

Plugin bridge giữa **OpenClaw** và **OpenCode** để phục vụ orchestration multi-agent, callback, SSE probing, routing envelope và serve runtime management.

## Mục tiêu
- Chuẩn hóa callback path từ OpenCode về OpenClaw qua `/hooks/agent`
- Chuẩn hóa `sessionKey` / `routing envelope`
- Hỗ trợ mô hình vận hành: **1 project = 1 OpenCode serve instance**
- Làm nền cho:
  - SSE probe / listener
  - callback execution
  - run status artifact
  - serve registry / spawn / reuse / shutdown / idle evaluation

## Package npm
```bash
openclaw plugins install @mrc2204/openclaw-opencode-bridge
```

## Cấu trúc chính
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

## Skill đi kèm
Repo này mang kèm skill:
- `skills/opencode-orchestration/SKILL.md`

Skill này mô tả cách đưa execution lane vào OpenCode theo hướng bridge-aware, thay vì `opencode run` ad-hoc.

## Tool hiện có
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
- `opencode_server_url` là field thực tế bắt buộc trong envelope

## Tình trạng hiện tại
Plugin này hiện ở mức **runtime-ops scaffold + PoC proven paths**:
- callback execution đã chạy thật
- SSE probe đã chạy thật
- mini listener runner đã chạy thật
- run-status artifact đã có thật
- serve registry / spawn / reuse / shutdown / idle evaluation đã có baseline

Nhưng chưa nên coi là production-perfect cho mọi edge case.

## Config mẫu
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

## Local dev
```bash
openclaw plugins install -l ~/Work/projects/opencode-bridge
```

## Ghi chú
- Không dùng `cron` hay `group:sessions` làm callback primary.
- Không assume một serve là multi-project-safe.
- Dùng `skills/opencode-orchestration` như entrypoint workflow cho execute lane của team.

## License
MIT
