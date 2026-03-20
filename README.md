# @mrc2204/opencode-bridge

> English README: [README.en.md](./README.en.md)

Plugin bridge giữa **OpenClaw** và **OpenCode** cho orchestration multi-agent, callback routing, SSE probing, run observability và serve runtime management.

## Mục tiêu
- Chuẩn hóa callback path từ OpenCode về OpenClaw qua `/hooks/agent`
- Chuẩn hóa `sessionKey` / `routing envelope`
- Hỗ trợ mô hình vận hành: **1 project = 1 OpenCode serve instance**
- Cung cấp runtime-ops baseline:
  - SSE probe / event normalize
  - run status / run events / session tail
  - serve registry / spawn / reuse / shutdown / idle evaluation

## Cài package từ npm
```bash
openclaw plugins install @mrc2204/openclaw-opencode-bridge
```

## Cấu trúc repo (build-based)
```text
openclaw-opencode-bridge/
├── openclaw.plugin.json
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── observability.ts
│   └── types.ts
├── dist/                  # artifact tạo bởi npm run build
├── test/
│   ├── run-tests.ts
│   └── observability.test.ts
├── skills/
│   └── opencode-orchestration/
│       └── SKILL.md
├── README.md
└── README.en.md
```

## Tool hiện có
- `opencode_status`
- `opencode_resolve_project`
- `opencode_build_envelope`
- `opencode_check_hook_policy`
- `opencode_evaluate_lifecycle`
- `opencode_run_status`
- `opencode_run_events`
- `opencode_session_tail`
- `opencode_serve_spawn`
- `opencode_registry_get`
- `opencode_registry_upsert`
- `opencode_registry_cleanup`
- `opencode_serve_shutdown`
- `opencode_serve_idle_check`

## Assumptions hiện tại
- `1 project = 1 opencode serve instance`
- callback primary = `/hooks/agent`
- `sessionKey` convention = `hook:opencode:<agentId>:<taskId>`
- `opencode_server_url` là field bắt buộc trong envelope routing thực tế

## Build/Test
```bash
npm install
npm run build
npm run typecheck
npm run test
```

Sau `npm run build`, entrypoint runtime dùng artifact trong `dist/`:
- `main`: `./dist/index.js`
- `types`: `./dist/index.d.ts`
- `openclaw.extensions`: `./dist/index.js`

## Publish flow (safe)
```bash
npm run build
npm run test
npm pack --dry-run
# nếu OK:
# npm publish
```

`npm pack --dry-run` dùng để kiểm tra package chỉ publish artifact cần thiết (`dist/`, `skills/`, readme, plugin manifest), không trỏ trực tiếp vào source TypeScript.

## Config runtime
Plugin dùng plugin-owned config tại:
```text
~/.openclaw/opencode-bridge/config.json
```

Ví dụ:
```json
{
  "opencodeServerUrl": "http://127.0.0.1:4096",
  "hookBaseUrl": "http://127.0.0.1:18789",
  "hookToken": "<OPENCLAW_HOOK_TOKEN>",
  "projectRegistry": [
    {
      "projectId": "agent-smart-memo",
      "repoRoot": "/Users/me/Work/projects/agent-smart-memo",
      "serverUrl": "http://127.0.0.1:4096",
      "idleTimeoutMs": 900000
    }
  ]
}
```

## Local dev plugin install
```bash
openclaw plugins install -l ~/Work/projects/opencode-bridge
```

## License
MIT
