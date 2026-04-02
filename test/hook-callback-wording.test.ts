import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const hookModule = require("../hooks/opencode-callback.js");

const buildContinuationInstruction: (
	payload: Record<string, unknown>,
	routedSessionKey: string,
) => string = hookModule.buildContinuationInstruction;

test("hook continuation text stays internal-only and does not synthesize operator-facing preamble", () => {
	const text = buildContinuationInstruction(
		{
			eventType: "task.completed",
			runId: "run-wording-1",
			taskId: "task-wording-1",
			requestedAgentId: "scrum",
			projectId: "proj-wording-1",
			repoRoot: "/tmp/repo-wording-1",
			callbackTargetSessionKey:
				"agent:scrum:opencode:scrum:callback:sess-wording-1",
			callbackTargetSessionId: "sess-wording-1",
			intent: {
				kind: "notify",
				notify: "Verify resumed state and keep continuation aligned.",
			},
		},
		"agent:scrum:opencode:scrum:callback:sess-wording-1",
	);

	assert.match(text, /OpenCode hook continuation control\./);
	assert.match(text, /Continuation intent: notify/);
	assert.match(text, /Internal notify\/control note:/);
	assert.match(
		text,
		/Any operator-facing update must be emitted by registrar authority only\./,
	);
	assert.doesNotMatch(text, /OpenCode Isolated Loop Update/);
	assert.doesNotMatch(
		text,
		/To operator on Telegram \(single concise update, deduplicated intent\):/,
	);
	assert.doesNotMatch(text, /Telegram target: operator \(direct update\)/);
	assert.doesNotMatch(text, /operator-facing update required/i);
});
