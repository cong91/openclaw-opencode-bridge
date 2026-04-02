# opencode-bridge production-ish install notes

## Mục tiêu

Ghi lại cách cài gần-production cho `opencode-bridge` theo hướng artifact-based và 2-side install flow rõ ràng.

## Nguyên tắc

1. OpenClaw side và OpenCode side là 2 runtime surface khác nhau.
2. Global OpenCode install phải dùng built artifact `.js`, không patch source `.ts` trực tiếp.
3. Multi-project safety quan trọng hơn reuse mù để giảm process count.

## Artifact view

### OpenClaw side

- main runtime artifact: `dist/src/index.js`
- types: `dist/src/index.d.ts`
- OpenClaw extension entry: `./dist/src/index.js`

### OpenCode side

- canonical source: `opencode-plugin/openclaw-bridge-callback.ts`
- built artifact: `dist/opencode-plugin/openclaw-bridge-callback.js`
- shared runtime chunk(s) may also be required from `dist/` depending on bundling output
- materialized runtime location:
  - project: `.opencode/plugins/openclaw-bridge-callback.js`
  - global: `~/.config/opencode/plugins/openclaw-bridge-callback.js`

## Install recommendation

### OpenClaw side

Use package/path install for productized copy/install flow.

### OpenCode side

Use materialize flow from built artifact:

```bash
npm run materialize:opencode-plugin:global
```

Or project-local:

```bash
npm run materialize:opencode-plugin:project
```

## User-facing unified flow

Preferred entrypoints:

```bash
npm run install:bridge:project
npm run install:bridge:global
```

## Required envs for callback path

- `OPENCLAW_HOOK_BASE_URL`
- `OPENCLAW_HOOK_TOKEN`

## Multi-project requirements

A production-ish install must preserve these invariants:

- shared serve may back multiple projects/sessions when session resolution remains directory/project-correct
- `serves.json` remains the serve lifecycle registry (spawn/reuse/adopt/health/shutdown/cleanup/stale-or-dead transitions)
- `sessions.json` remains the session mapping registry (session-to-serve mapping + current-for-directory state)
- session tags must include run/task/callback identity
- dedupe key must not collide across unrelated sessions or runs
- callback must target the intended lane/session only

## Release hygiene before publishing

- `npm run build`
- `npm run test -- --runInBand`
- verify package metadata points to real built artifacts
- verify materialize script uses built plugin artifact, not raw TS source
- verify README/install story matches actual scripts

## Current note

Step 1 callback path is functionally complete, and OpenCode-side plugin callback e2e has been proven with HTTP 200 against `/hooks/agent`. Remaining work is polish/hardening rather than architectural uncertainty.
