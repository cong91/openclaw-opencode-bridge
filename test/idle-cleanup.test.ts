import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { cleanupExpiredServes } from "../src/runtime";

const tmpDir = "/tmp/opencode-bridge-idle-cleanup-test";
const stateDir = join(tmpDir, ".openclaw", "opencode-bridge");
const registryPath = join(stateDir, "registry.json");

test("cleanupExpiredServes stops running entries whose idle timeout is exceeded", () => {
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
            project_id: "fresh-proj",
            repo_root: "/tmp/fresh-proj",
            opencode_server_url: "http://127.0.0.1:5002",
            pid: 999998,
            status: "running",
            last_event_at: new Date(now - 1_000).toISOString(),
            idle_timeout_ms: 60_000,
            updated_at: new Date(now - 1_000).toISOString(),
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = cleanupExpiredServes(now);
  assert.equal(result.ok, true);
  assert.equal(result.stopped, 1);
  assert.equal(result.checked, 2);
  const idle = result.results.find((x) => x.project_id === "idle-proj");
  const fresh = result.results.find((x) => x.project_id === "fresh-proj");
  assert.equal(idle?.status, "stopped");
  assert.equal(idle?.reason, "idle_timeout_exceeded");
  assert.equal(fresh?.status, "running");
});
