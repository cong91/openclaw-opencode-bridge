# @mrc2204/opencode-bridge

OpenClaw ↔ OpenCode bridge for hybrid execution, callback orchestration, and multi-project-safe runtime control.

## What it does
`opencode-bridge` connects two runtime surfaces:
- **OpenClaw side**: project-aware routing, run state, serve management, observability, and callback policy
- **OpenCode side**: event-driven callback plugin for terminal session lifecycle events

It is designed for teams that want:
- project-aware OpenCode execution
- callback flow back into OpenClaw via `/hooks/agent`
- installable OpenCode-side plugin artifacts
- multi-project-safe runtime boundaries

## Install
### 1) OpenClaw side
```bash
openclaw plugins install @mrc2204/openclaw-opencode-bridge
```

### 2) OpenCode side — project install
```bash
npm run materialize:opencode-plugin:project
```

### 3) OpenCode side — global install
```bash
npm run materialize:opencode-plugin:global
```

Global mode auto-patches `~/.config/opencode/opencode.json` when it exists.

### 4) One-command install
Project mode:
```bash
npm run install:bridge:project
```

Global mode:
```bash
npm run install:bridge:global
```

## Required callback environment
The OpenCode-side callback plugin needs:
- `OPENCLAW_HOOK_BASE_URL`
- `OPENCLAW_HOOK_TOKEN`

Optional:
- `OPENCLAW_BRIDGE_AUDIT_DIR`
- `OPENCLAW_BRIDGE_OPENCLAW_AUDIT_PATH`

## Runtime model
### Hybrid execution strategy
`opencode-bridge` supports two practical execution lanes:
- **CLI-direct**: lightweight execution for simpler tasks
- **serve/plugin mode**: canonical path for callback, observability, and event-driven lifecycle handling

### Multi-project safety
Current contracts assume:
- `1 project = 1 correctly bound OpenCode serve instance`
- serve reuse is allowed only when runtime introspection confirms the expected `repo_root`
- bridge session tags must preserve callback identity per run/session

## Build and verify
```bash
npm install
npm run build
npm test -- --runInBand
```

## Package / artifact layout
```text
openclaw-opencode-bridge/
├── src/                 # OpenClaw-side runtime
├── opencode-plugin/     # canonical OpenCode-side plugin source
├── scripts/             # materialize/install helpers
├── dist/                # built artifacts
├── docs/                # install / architecture / contracts
└── skills/              # bridge-related skills/docs
```

## More docs
- `docs/install/quick-start-2026-03-22.md`
- `docs/install/production-ish-install-2026-03-22.md`
- `docs/contracts/multi-project-contract-draft-2026-03-22.md`
- `docs/architecture/hybrid-execution-strategy-2026-03-22.md`

Developer-only local debug notes are intentionally kept out of this README. See:
- `docs/install/developer-local-debug-2026-03-22.md`

## Status
Current status: functional and productized enough for real use, with hardening history reflected in tests and docs.
