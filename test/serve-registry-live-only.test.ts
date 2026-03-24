import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { upsertServeRegistry, getServeRegistryPath } from "../src/runtime";

test("upsertServeRegistry keeps only one live running serve entry", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "opb-serve-live-only-"));
  const stateDir = join(tempRoot, "state");
  const bridgeDir = join(stateDir, "opencode-bridge");
  mkdirSync(bridgeDir, { recursive: true });

  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;

  try {
    upsertServeRegistry({
      serve_id: "http://127.0.0.1:60001",
      opencode_server_url: "http://127.0.0.1:60001",
      pid: 60001,
      status: "running",
      updated_at: new Date().toISOString(),
    } as any);
    upsertServeRegistry({
      serve_id: "http://127.0.0.1:60002",
      opencode_server_url: "http://127.0.0.1:60002",
      pid: 60002,
      status: "running",
      updated_at: new Date().toISOString(),
    } as any);

    const persisted = JSON.parse(readFileSync(getServeRegistryPath(), "utf8"));
    assert.equal(Array.isArray(persisted.entries), true);
    assert.equal(persisted.entries.length, 1);
    assert.equal(persisted.entries[0].opencode_server_url, "http://127.0.0.1:60002");
  } finally {
    if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prevStateDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
