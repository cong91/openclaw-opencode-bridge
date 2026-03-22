import test from "node:test";
import assert from "node:assert/strict";

import { buildTaggedSessionTitle, buildPluginCallbackDedupeKey } from "../src/shared-contracts";

test("shared contract keeps project-safe tags and dedupe stable across projects", () => {
  const titleA = buildTaggedSessionTitle({
    runId: "run-a",
    taskId: "task-a",
    requested: "fullstack",
    resolved: "fullstack",
    callbackSession: "agent:fullstack:telegram:direct:5165741309",
    callbackSessionId: "sess-a",
    projectId: "project-a",
    repoRoot: "/tmp/project-a",
  });
  const titleB = buildTaggedSessionTitle({
    runId: "run-b",
    taskId: "task-b",
    requested: "fullstack",
    resolved: "fullstack",
    callbackSession: "agent:fullstack:telegram:direct:5165741309",
    callbackSessionId: "sess-b",
    projectId: "project-b",
    repoRoot: "/tmp/project-b",
  });

  assert.match(titleA, /projectId=project-a/);
  assert.match(titleA, /repoRoot=\/tmp\/project-a/);
  assert.match(titleB, /projectId=project-b/);
  assert.match(titleB, /repoRoot=\/tmp\/project-b/);

  const dedupeA = buildPluginCallbackDedupeKey({ sessionId: "sess-a", runId: "run-a" });
  const dedupeB = buildPluginCallbackDedupeKey({ sessionId: "sess-b", runId: "run-b" });

  assert.notEqual(dedupeA, dedupeB);
});
