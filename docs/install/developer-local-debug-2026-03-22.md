# opencode-bridge developer local debug

## Audience
This document is for maintainers and local developers of `opencode-bridge`, not end users installing the published package.

## Local OpenClaw debug flow
Use a direct local repo load path in OpenClaw config rather than relying on `openclaw plugins install -l` as the primary development workflow.

Typical loop:
1. edit code in local repo
2. run `npm run build`
3. restart/reload gateway runtime
4. verify runtime loaded the new plugin build

## Local OpenCode debug flow
For project-local OpenCode plugin debugging:
1. build the repo
2. materialize the OpenCode-side plugin into the target project
3. run OpenCode serve with the callback envs you want to test
4. inspect plugin audit + OpenClaw-side audit

Useful commands:
```bash
npm run build
npm run materialize:opencode-plugin:project
npm test -- --runInBand
```

## Notes
- `.opencode/plugins/` in the repo is a runtime/test surface.
- Canonical OpenCode-side plugin source lives in `opencode-plugin/`.
- The materialize flow should use built `.js` artifacts, not raw `.ts` source.
- Local debug and public install flows should be documented separately.
