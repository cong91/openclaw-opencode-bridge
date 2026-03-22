# OpenCode-side plugin boundary

This directory is the intended home for the canonical OpenCode-side callback plugin source.

## Current transitional state
The active runtime-tested plugin file currently lives at:
- `.opencode/plugins/openclaw-bridge-callback.ts`

That location is convenient for project-local loading in OpenCode.

## Current source-of-truth
Canonical OpenCode-side plugin source now lives at:
- `opencode-plugin/openclaw-bridge-callback.ts`

The runtime-loaded project-local file remains:
- `.opencode/plugins/openclaw-bridge-callback.ts`

but it should be treated as a thin re-export shim for local OpenCode loading during development.

## Intended next step
Promote this boundary further so the repository can ship:
- OpenClaw-side bridge artifact
- OpenCode-side callback plugin artifact

from one source-of-truth without mixing runtime test placement with canonical source layout.
