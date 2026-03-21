import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSseFramesFromBuffer,
  parseSseData,
  unwrapGlobalPayload,
  normalizeTypedEventV1,
  resolveSessionId,
  summarizeLifecycle,
} from "../src/observability";

test("parseSseFramesFromBuffer parses event/id/data frames", () => {
  const input = [
    "event: message",
    "id: 42",
    "data: {\"kind\":\"progress\",\"run_id\":\"run-1\"}",
    "",
    "",
  ].join("\n");

  const parsed = parseSseFramesFromBuffer(input);
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.remainder, "");
  assert.equal(parsed.frames[0].event, "message");
  assert.equal(parsed.frames[0].id, "42");
  assert.equal(parsed.frames[0].data, '{"kind":"progress","run_id":"run-1"}');
});

test("parseSseFramesFromBuffer keeps partial frame as remainder", () => {
  const input = "data: {\"kind\":\"progress\"}";
  const parsed = parseSseFramesFromBuffer(input);
  assert.equal(parsed.frames.length, 0);
  assert.equal(parsed.remainder, input);
});

test("unwrapGlobalPayload unwraps payload wrappers from global stream", () => {
  const raw = {
    payload: {
      payload: {
        run_id: "run-2",
        task_id: "task-2",
        session_id: "sess-2",
        status: "completed",
      },
    },
  };
  const unwrapped = unwrapGlobalPayload(raw);
  assert.deepEqual(unwrapped.wrappers, ["payload", "payload"]);
  assert.equal(unwrapped.payload.run_id, "run-2");
  assert.equal(unwrapped.payload.task_id, "task-2");
  assert.equal(unwrapped.payload.session_id, "sess-2");
});

test("normalizeTypedEventV1 emits typed event schema with extracted correlation ids", () => {
  const frame = {
    event: "message",
    id: "evt-1",
    data: JSON.stringify({
      payload: {
        run_id: "run-3",
        task_id: "task-3",
        session_id: "sess-3",
        status: "completed",
      },
    }),
    raw: "data: ...",
  };
  const typed = normalizeTypedEventV1(frame, "global");
  assert.equal(typed.schema, "opencode.event.v1");
  assert.equal(typed.scope, "global");
  assert.equal(typed.eventName, "message");
  assert.equal(typed.eventId, "evt-1");
  assert.equal(typed.kind, "task.completed");
  assert.equal(typed.runId, "run-3");
  assert.equal(typed.taskId, "task-3");
  assert.equal(typed.sessionId, "sess-3");
});

test("resolveSessionId prefers explicit then artifact then scored fallback", () => {
  const sessionList = [
    {
      id: "sess-latest",
      time: { updated: 200 },
      metadata: { run_id: "other-run" },
    },
    {
      id: "sess-match",
      time: { updated: 100 },
      metadata: { run_id: "run-needle", task_id: "task-needle", session_key: "hook:opencode:agent:task-needle" },
    },
  ];

  const explicit = resolveSessionId({
    explicitSessionId: "sess-explicit",
    runId: "run-needle",
    taskId: "task-needle",
    sessionList,
  });
  assert.equal(explicit.strategy, "explicit");
  assert.equal(explicit.sessionId, "sess-explicit");

  const artifact = resolveSessionId({
    artifactSessionId: "sess-match",
    runId: "run-needle",
    taskId: "task-needle",
    sessionList,
  });
  assert.equal(artifact.strategy, "artifact");
  assert.equal(artifact.sessionId, "sess-match");

  const scored = resolveSessionId({
    runId: "run-needle",
    taskId: "task-needle",
    sessionKey: "hook:opencode:agent:task-needle",
    sessionList,
  });
  assert.equal(scored.strategy, "scored_fallback");
  assert.equal(scored.sessionId, "sess-match");
});

test("parseSseData returns raw wrapper for non-json payload", () => {
  const parsed = parseSseData("not-json");
  assert.deepEqual(parsed, { raw: "not-json" });
});

test("normalizeTypedEventV1 + summarizeLifecycle extract semantic lifecycle envelope", () => {
  const frames = [
    {
      event: "message",
      id: "evt-plan",
      data: JSON.stringify({ payload: { type: "task.progress", text: "planning discovery phase" } }),
      raw: "data: ...",
    },
    {
      event: "message",
      id: "evt-code",
      data: JSON.stringify({ payload: { type: "task.progress", tool: "apply_patch", files: ["src/runtime.ts"] } }),
      raw: "data: ...",
    },
    {
      event: "message",
      id: "evt-verify",
      data: JSON.stringify({ payload: { type: "task.progress", state: { input: { command: "npm test" }, metadata: { exit: 0, output: "PASS" } } } }),
      raw: "data: ...",
    },
    {
      event: "message",
      id: "evt-done",
      data: JSON.stringify({ payload: { type: "task.completed", text: "done summary" } }),
      raw: "data: ...",
    },
  ];

  const typed = frames.map((frame) => normalizeTypedEventV1(frame, "global"));
  const summary = summarizeLifecycle(typed);

  assert.equal(typed[0].lifecycleState, "planning");
  assert.equal(typed[1].lifecycleState, "coding");
  assert.equal(typed[2].lifecycleState, "verifying");
  assert.equal(summary.current_state, "completed");
  assert.deepEqual(summary.files_changed, ["src/runtime.ts"]);
  assert.equal(summary.verify_summary.length, 1);
  assert.equal(summary.verify_summary[0].command, "npm test");
  assert.equal(summary.completion_summary, "done summary");
});
