import test from "node:test";
import assert from "node:assert/strict";

import { buildEnvelope, buildHooksAgentCallback, resolveExecutionAgent } from "../src/runtime";

test("resolveExecutionAgent uses explicit executionAgentId when provided", () => {
  const resolved = resolveExecutionAgent({
    cfg: {},
    requestedAgentId: "creator",
    explicitExecutionAgentId: "coder-lane",
  });

  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.requestedAgentId, "creator");
  assert.equal(resolved.resolvedAgentId, "coder-lane");
  assert.equal(resolved.strategy, "explicit_param");
});

test("resolveExecutionAgent fails when mappings exist but requested agent is unmapped", () => {
  const resolved = resolveExecutionAgent({
    cfg: {
      executionAgentMappings: [
        { requestedAgentId: "creator", executionAgentId: "coder-lane" },
      ],
    },
    requestedAgentId: "scrum",
  });

  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.mappingConfigured, true);
  assert.match(resolved.error, /no mapping matched/i);
});

test("buildEnvelope preserves origin session context and callback target", () => {
  const envelope = buildEnvelope({
    taskId: "task-1",
    runId: "run-1",
    requestedAgentId: "creator",
    resolvedAgentId: "coder-lane",
    originSessionKey: "session:origin:key",
    originSessionId: "session-origin-id",
    projectId: "proj-1",
    repoRoot: "/tmp/repo",
    serverUrl: "http://127.0.0.1:4096",
  });

  assert.equal(envelope.agent_id, "coder-lane");
  assert.equal(envelope.requested_agent_id, "creator");
  assert.equal(envelope.resolved_agent_id, "coder-lane");
  assert.equal(envelope.origin_session_key, "session:origin:key");
  assert.equal(envelope.origin_session_id, "session-origin-id");
  assert.equal(envelope.callback_target_session_key, "session:origin:key");
  assert.equal(envelope.callback_target_session_id, "session-origin-id");
});

test("buildHooksAgentCallback routes callback to requester agent + origin session", () => {
  const envelope = buildEnvelope({
    taskId: "task-2",
    runId: "run-2",
    requestedAgentId: "creator",
    resolvedAgentId: "coder-lane",
    originSessionKey: "session:origin:key:2",
    originSessionId: "origin-session-2",
    projectId: "proj-2",
    repoRoot: "/tmp/repo2",
    serverUrl: "http://127.0.0.1:4097",
  });

  const callback = buildHooksAgentCallback({
    event: "task.progress",
    envelope,
  });

  assert.equal(callback.agentId, "creator");
  assert.equal(callback.sessionKey, "session:origin:key:2");
  assert.equal(callback.sessionId, "origin-session-2");
  assert.match(callback.message, /requestedAgent=creator/);
  assert.match(callback.message, /resolvedAgent=coder-lane/);
});
