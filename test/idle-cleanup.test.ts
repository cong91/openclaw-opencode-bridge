import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import * as runtime from "../src/runtime";

const tmpDir = "/tmp/opencode-bridge-idle-cleanup-test";
const stateDir = join(tmpDir, ".openclaw", "opencode-bridge");
const registryPath = join(stateDir, "registry.json");

test("cleanupExpiredServes stops only idle entries and preserves busy runtime sessions", async () => {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = join(tmpDir, ".openclaw");

  const now = Date.now();
  writeFileSync(
    registryPath,
    JSON.stringify(
      {
        entries: [
          {
            project_id: "idle-proj",
            repo_root: "/tmp/idle-proj",
            opencode_server_url: "http://127.0.0.1:5001",
            pid: 999999,
            status: "running",
            last_event_at: new Date(now - 20_000).toISOString(),
            idle_timeout_ms: 5_000,
            updated_at: new Date(now - 20_000).toISOString(),
          },
          {
            project_id: "busy-proj",
            repo_root: "/tmp/busy-proj",
            opencode_server_url: "http://127.0.0.1:5002",
            pid: 999998,
            status: "running",
            last_event_at: new Date(now - 20_000).toISOString(),
            idle_timeout_ms: 5_000,
            updated_at: new Date(now - 20_000).toISOString(),
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const originalFetchJsonSafe = runtime.fetchJsonSafe;
  // @ts-expect-error test monkey patch
  runtime.fetchJsonSafe = async (url: string) => {
    if (url.includes('5001') && url.endsWith('/session/status')) return { ok: true, data: {} };
    if (url.includes('5001') && url.endsWith('/session')) return { ok: true, data: [] };
    if (url.includes('5002') && url.endsWith('/session/status')) return { ok: true, data: { 'sess-busy': { type: 'busy' } } };
    if (url.includes('5002') && url.endsWith('/session')) return { ok: true, data: [{ id: 'sess-busy' }] };
    return { ok: false, error: 'unexpected url' };
  };

  try {
    const result = await runtime.cleanupExpiredServes(now);
    assert.equal(result.ok, true);
    assert.equal(result.stopped, 1);
    const idle = result.results.find((x) => x.project_id === "idle-proj");
    const busy = result.results.find((x) => x.project_id === "busy-proj");
    assert.equal(idle?.status, "stopped");
    assert.equal(idle?.reason, "idle_timeout_exceeded");
    assert.equal(busy?.status, "running");
    assert.equal(busy?.reason, "runtime_busy_session_detected");
  } finally {
    // @ts-expect-error restore monkey patch
    runtime.fetchJsonSafe = originalFetchJsonSafe;
  }
});
