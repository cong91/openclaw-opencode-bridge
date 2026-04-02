import assert from "node:assert/strict";
import test from "node:test";

import {
	buildPluginCallbackDedupeKey,
	buildTaggedSessionTitle,
} from "../src/shared-contracts";

test("shared contract keeps project-safe tags and dedupe stable across projects", () => {
	const titleA = buildTaggedSessionTitle({
		runId: "run-a",
		taskId: "task-a",
		requested: "fullstack",
		resolved: "fullstack",
		callbackSession: "agent:fullstack:opencode:fullstack:callback:sess-a",
		originSession: "agent:fullstack:telegram:direct:5165741309",
		originSessionId: "sess-a",
		callbackRelaySession: "agent:fullstack:telegram:direct:5165741309",
		callbackRelaySessionId: "sess-a",
		projectId: "project-a",
		repoRoot: "/tmp/project-a",
	});
	const titleB = buildTaggedSessionTitle({
		runId: "run-b",
		taskId: "task-b",
		requested: "fullstack",
		resolved: "fullstack",
		callbackSession: "agent:fullstack:opencode:fullstack:callback:sess-b",
		originSession: "agent:fullstack:telegram:direct:5165741309",
		originSessionId: "sess-b",
		callbackRelaySession: "agent:fullstack:telegram:direct:5165741309",
		callbackRelaySessionId: "sess-b",
		projectId: "project-b",
		repoRoot: "/tmp/project-b",
	});

	assert.match(titleA, /projectId=project-a/);
	assert.match(titleA, /repoRoot=\/tmp\/project-a/);
	assert.match(titleB, /projectId=project-b/);
	assert.match(titleB, /repoRoot=\/tmp\/project-b/);

	const dedupeA = buildPluginCallbackDedupeKey({
		sessionId: "sess-a",
		runId: "run-a",
	});
	const dedupeB = buildPluginCallbackDedupeKey({
		sessionId: "sess-b",
		runId: "run-b",
	});

	assert.notEqual(dedupeA, dedupeB);
});
