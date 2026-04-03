import assert from "node:assert/strict";
import test from "node:test";

import {
  mapCallbackEventToArtifactState,
  reconcileRunArtifactSnapshotFromCallback,
} from "../src/callback-artifact-reconciliation";
import type { BridgeRunStatus } from "../src/types";

test("shared callback reconciliation maps terminal callback consistently", () => {
  const mapped = mapCallbackEventToArtifactState("message.updated");
  assert.deepEqual(mapped, {
    state: "completed",
    lastEvent: "task.completed",
    terminal: true,
  });
});

test("shared callback reconciliation updates artifact fields and cleans attach pid once", () => {
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const next = reconcileRunArtifactSnapshotFromCallback({
    current: {
      taskId: "task-shared-1",
      runId: "run-shared-1",
      state: "running",
      lastEvent: "task.progress",
      lastSummary: "Attach-run dispatched; waiting for callback authority",
      updatedAt: "2000-01-01T00:00:00.000Z",
      attachRun: {
        pid: 43210,
        started: true,
      },
      envelope: {
        task_id: "task-shared-1",
        run_id: "run-shared-1",
        agent_id: "assistant",
        requested_agent_id: "assistant",
        resolved_agent_id: "assistant",
        session_key: "agent:assistant:opencode:assistant:callback:sess-shared-1",
        origin_session_key: "session:origin:shared-1",
        callback_target_session_key:
          "agent:assistant:opencode:assistant:callback:sess-shared-1",
        callback_target_session_id: "sess-shared-1",
        project_id: "proj-shared-1",
        repo_root: "/tmp/repo-shared-1",
        opencode_server_url: "http://opencode.local",
      },
    } as BridgeRunStatus,
    eventType: "session.idle",
    callbackAt: "2026-04-03T08:00:00.000Z",
    callbackOk: true,
    callbackStatus: 200,
    callbackBody: JSON.stringify({ ok: true, via: "test" }),
    callbackError: undefined,
    includeRealState: true,
    includeStateConfidence: true,
    killProcess: (pid, signal) => {
      killCalls.push({ pid, signal });
    },
  });

  assert.ok(next);
  assert.equal(next?.state, "completed");
  assert.equal(next?.lastEvent, "task.completed");
  assert.equal(next?.realState, "completed");
  assert.equal(next?.stateConfidence, "artifact_plus_callback");
  assert.equal(next?.callbackOk, true);
  assert.equal(next?.callbackStatus, 200);
  assert.equal(next?.callbackSentAt, "2026-04-03T08:00:00.000Z");
  assert.match(String(next?.lastSummary), /Terminal callback materialized \(session.idle\)/);
  assert.equal(next?.callbackCleaned, true);
  assert.equal(next?.attachRun?.cleaned, true);
  assert.equal(next?.attachRun?.killResult, "sigterm_sent");
  assert.deepEqual(killCalls, [{ pid: 43210, signal: "SIGTERM" }]);
});

test("shared callback reconciliation preserves terminal summary on non-terminal follow-up", () => {
  const next = reconcileRunArtifactSnapshotFromCallback({
    current: {
      taskId: "task-shared-2",
      runId: "run-shared-2",
      state: "completed",
      lastEvent: "task.completed",
      lastSummary: "Already finalized earlier",
      updatedAt: "2000-01-01T00:00:00.000Z",
      envelope: {
        task_id: "task-shared-2",
        run_id: "run-shared-2",
        agent_id: "assistant",
        requested_agent_id: "assistant",
        resolved_agent_id: "assistant",
        session_key: "agent:assistant:opencode:assistant:callback:sess-shared-2",
        origin_session_key: "session:origin:shared-2",
        callback_target_session_key:
          "agent:assistant:opencode:assistant:callback:sess-shared-2",
        callback_target_session_id: "sess-shared-2",
        project_id: "proj-shared-2",
        repo_root: "/tmp/repo-shared-2",
        opencode_server_url: "http://opencode.local",
      },
    } as BridgeRunStatus,
    eventType: "task.progress",
    callbackAt: "2026-04-03T08:10:00.000Z",
    callbackOk: true,
    callbackStatus: 200,
  });

  assert.ok(next);
  assert.equal(next?.state, "completed");
  assert.equal(next?.lastEvent, "task.completed");
  assert.equal(next?.lastSummary, "Already finalized earlier");
  assert.equal(next?.callbackOk, true);
  assert.equal(next?.callbackStatus, 200);
  assert.equal(next?.callbackSentAt, "2026-04-03T08:10:00.000Z");
});
