import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reconcileRunArtifactFromHook } from "../hooks/opencode-callback.js";

const typedReconcileRunArtifactFromHook: (payload: Record<string, unknown>) => any =
  reconcileRunArtifactFromHook;

test("hook ingress reconciles terminal callback into run artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-hook-artifact-"));
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;

  try {
    const bridgeDir = join(root, "opencode-bridge");
    const runsDir = join(bridgeDir, "runs");
    mkdirSync(runsDir, { recursive: true });

    const runId = "run-hook-terminal-1";
    const runPath = join(runsDir, `${runId}.json`);
    writeFileSync(
      runPath,
      JSON.stringify(
        {
          taskId: "task-hook-terminal-1",
          runId,
          state: "running",
          lastEvent: null,
          lastSummary: "Attach-run dispatched; waiting for callback authority",
          updatedAt: "2000-01-01T00:00:00.000Z",
          envelope: {
            task_id: "task-hook-terminal-1",
            run_id: runId,
            agent_id: "assistant",
            requested_agent_id: "assistant",
            resolved_agent_id: "assistant",
            session_key: "agent:assistant:opencode:assistant:callback:sess-hook-1",
            origin_session_key: "session:origin:hook-1",
            callback_target_session_key:
              "agent:assistant:opencode:assistant:callback:sess-hook-1",
            callback_target_session_id: "sess-hook-1",
            project_id: "proj-hook-1",
            repo_root: "/tmp/repo-hook-1",
            opencode_server_url: "http://opencode.local",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const next = typedReconcileRunArtifactFromHook({
      eventType: "session.idle",
      runId,
      taskId: "task-hook-terminal-1",
    });

    assert.equal(next.state, "completed");
    assert.equal(next.lastEvent, "task.completed");
    assert.equal(next.callbackOk, true);
    assert.equal(next.callbackStatus, 200);
    assert.equal(next.stateConfidence, "artifact_plus_callback");
    assert.match(next.lastSummary, /Terminal callback materialized \(session.idle\)/);
    assert.equal(typeof next.callbackSentAt, "string");
    assert.equal(typeof next.updatedAt, "string");

    const persisted = JSON.parse(readFileSync(runPath, "utf8"));
    assert.equal(persisted.state, "completed");
    assert.equal(persisted.lastEvent, "task.completed");
    assert.equal(persisted.callbackOk, true);
    assert.equal(persisted.callbackStatus, 200);
    assert.equal(typeof persisted.callbackSentAt, "string");
    assert.equal(typeof persisted.updatedAt, "string");
    assert.match(persisted.callbackBody, /"via":"hook_ingress"/);
    assert.match(persisted.callbackBody, /"eventType":"session.idle"/);
    assert.match(persisted.callbackBody, /"runId":"run-hook-terminal-1"/);
  } finally {
    if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prevStateDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook ingress preserves terminal state on non-terminal follow-up callback while still stamping callback fields", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-hook-artifact-preserve-"));
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;

  try {
    const bridgeDir = join(root, "opencode-bridge");
    const runsDir = join(bridgeDir, "runs");
    mkdirSync(runsDir, { recursive: true });

    const runId = "run-hook-preserve-1";
    const runPath = join(runsDir, `${runId}.json`);
    writeFileSync(
      runPath,
      JSON.stringify(
        {
          taskId: "task-hook-preserve-1",
          runId,
          state: "completed",
          lastEvent: "task.completed",
          lastSummary: "Already finalized earlier",
          callbackOk: true,
          callbackStatus: 200,
          callbackSentAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    const next = typedReconcileRunArtifactFromHook({
      eventType: "task.progress",
      runId,
    });

    assert.equal(next.state, "completed");
    assert.equal(next.lastEvent, "task.completed");
    assert.equal(next.lastSummary, "Already finalized earlier");
    assert.equal(next.callbackOk, true);
    assert.equal(next.callbackStatus, 200);
    assert.equal(typeof next.callbackSentAt, "string");
    assert.equal(typeof next.updatedAt, "string");

    const persisted = JSON.parse(readFileSync(runPath, "utf8"));
    assert.equal(persisted.state, "completed");
    assert.equal(persisted.lastEvent, "task.completed");
    assert.equal(persisted.lastSummary, "Already finalized earlier");
    assert.match(persisted.callbackBody, /"eventType":"task.progress"/);
  } finally {
    if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prevStateDir;
    rmSync(root, { recursive: true, force: true });
  }
});
