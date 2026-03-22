# Install / deploy flow draft for opencode-bridge

## Goal
Define a clean install story for both sides of the bridge:
- OpenClaw-side plugin
- OpenCode-side plugin

## Current state
### OpenClaw-side
Loaded from local path via OpenClaw plugin config.

### OpenCode-side
Currently tested as a project-local plugin in:
- `.opencode/plugins/openclaw-bridge-callback.ts`

## Target install model
### Artifact A: OpenClaw-side bridge
- packaged as normal OpenClaw plugin
- installed/loaded by OpenClaw
- owns project routing, serve management, run state, and bridge audit

### Artifact B: OpenCode-side callback plugin
- shipped from the same source repo but treated as separate runtime artifact
- installed into either:
  - project-local `.opencode/plugins/`
  - or global `~/.config/opencode/plugins/`
- owns internal event subscription and callback dispatch

## Local test mode
- OpenClaw loads local repo path directly
- OpenCode loads project-local plugin file
- env vars are injected manually for callback testing

## Production-ish mode
- OpenClaw installs published bridge artifact
- OpenCode-side plugin is materialized into the target OpenCode plugin directory
- global mode auto-patches OpenCode global config when present
- callback envs are provisioned explicitly

## Current materialization flow
A helper script now exists in repo:
- `scripts/materialize-opencode-plugin.mjs`

Supported commands:
- `npm run materialize:opencode-plugin:project`
- `npm run materialize:opencode-plugin:global`

Behavior:
- copies built plugin artifact from `dist/opencode-plugin/openclaw-bridge-callback.js`
- materializes plugin runtime into the chosen OpenCode plugin directory as `openclaw-bridge-callback.js`
- updates project-local `.opencode/opencode.json` when using project mode and config file exists
- no longer depends on copying generated chunk files for the OpenCode-side plugin artifact

## Updated materialization policy
Global mode now auto-patches OpenCode global config when `~/.config/opencode/opencode.json` exists.

## Open questions for next pass
1. Should the repo publish one package with two artifacts, or separate artifacts from one repo?
2. Should install flow manage callback env provisioning explicitly?
3. Should global flow also provision/update callback env docs alongside plugin config patching?
