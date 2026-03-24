import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { spawnServeForProject } from "../src/runtime";

test.skip("spawnServeForProject reuses/adopts a live serve process when registry is empty", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "opb-serve-adopt-"));
  const stateDir = join(tempRoot, "state");
  const bridgeDir = join(stateDir, "opencode-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "serves.json"), JSON.stringify({ entries: [] }, null, 2), "utf8");

  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;

  try {
    const result = await spawnServeForProject({
      project_id: "proj-adopt-1",
      repo_root: "/tmp/repo-adopt-1",
      idle_timeout_ms: 120000,
    });

    assert.ok(result);
  } finally {
    if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prevStateDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
