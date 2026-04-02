import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerOpenCodeBridgeTools } from "../src/registrar";
import { buildHooksAgentCallback } from "../src/runtime";

type RegisteredTool = {
	name: string;
	execute: (_id: string, params: any) => Promise<any>;
};

function parseToolJson(result: any) {
	const text = result?.content?.[0]?.text;
	assert.equal(
		typeof text,
		"string",
		"tool result must return content[0].text JSON string",
	);
	return JSON.parse(text as string);
}

function setupToolHarness(configFile: any) {
	const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-test-"));
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	mkdirSync(bridgeDir, { recursive: true });
	writeFileSync(
		join(bridgeDir, "config.json"),
		JSON.stringify(configFile, null, 2),
		"utf8",
	);

	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	const tools = new Map<string, RegisteredTool>();
	const api = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
	};

	registerOpenCodeBridgeTools(api, {});

	return {
		tools,
		cleanup() {
			if (prevStateDir === undefined) {
				delete process.env.OPENCLAW_STATE_DIR;
			} else {
				process.env.OPENCLAW_STATE_DIR = prevStateDir;
			}
			rmSync(tempRoot, { recursive: true, force: true });
		},
	};
}

test("opencode_build_envelope contract preserves origin/requested/resolved and callback target routing", async () => {
	const harness = setupToolHarness({
		opencodeServerUrl: "http://127.0.0.1:4096",
		projectRegistry: [
			{
				projectId: "proj-1",
				repoRoot: "/tmp/repo",
				serverUrl: "http://127.0.0.1:5001",
			},
		],
		executionAgentMappings: [
			{
				requestedAgentId: "creator",
				executionAgentId: "coder-lane",
			},
		],
	});

	try {
		const tool = harness.tools.get("opencode_build_envelope");
		assert.ok(tool, "opencode_build_envelope should be registered");

		const result = await tool!.execute("test", {
			taskId: "task-123",
			runId: "run-123",
			agentId: "creator",
			originSessionKey: "session:origin:key",
			originSessionId: "session-origin-id",
			projectId: "proj-1",
			repoRoot: "/tmp/repo",
			channel: "telegram",
			to: "user:abc",
			deliver: false,
			priority: "high",
		});

		assert.equal(result?.isError, undefined);
		const payload = parseToolJson(result);
		assert.equal(payload.ok, true);

		const envelope = payload.envelope;
		assert.equal(envelope.agent_id, "coder-lane");
		assert.equal(envelope.requested_agent_id, "creator");
		assert.equal(envelope.resolved_agent_id, "coder-lane");
		assert.equal(envelope.origin_session_key, "session:origin:key");
		assert.equal(envelope.origin_session_id, "session-origin-id");
		assert.equal(
			envelope.callback_target_session_key,
			"agent:creator:opencode:creator:callback:session%3Aorigin%3Akey",
		);
		assert.equal(envelope.callback_target_session_id, undefined);
		assert.equal(envelope.callback_relay_session_key, "session:origin:key");
		assert.equal(envelope.callback_relay_session_id, "session-origin-id");

		const callback = buildHooksAgentCallback({
			event: "task.progress",
			envelope,
		});
		assert.equal(callback.agentId, "creator");
		assert.equal(
			callback.sessionKey,
			"agent:creator:opencode:creator:callback:session%3Aorigin%3Akey",
		);
		assert.equal(callback.sessionId, undefined);
		assert.match(callback.message, /requestedAgent=creator/);
		assert.match(callback.message, /resolvedAgent=coder-lane/);
	} finally {
		harness.cleanup();
	}
});

test("opencode_build_envelope fails when mapping is configured but requested agent is not mapped", async () => {
	const harness = setupToolHarness({
		projectRegistry: [
			{
				projectId: "proj-1",
				repoRoot: "/tmp/repo",
				serverUrl: "http://127.0.0.1:5001",
			},
		],
		executionAgentMappings: [
			{
				requestedAgentId: "creator",
				executionAgentId: "coder-lane",
			},
		],
	});

	try {
		const tool = harness.tools.get("opencode_build_envelope");
		assert.ok(tool, "opencode_build_envelope should be registered");

		const result = await tool!.execute("test", {
			taskId: "task-404",
			runId: "run-404",
			agentId: "scrum",
			originSessionKey: "session:origin:missing",
			projectId: "proj-1",
			repoRoot: "/tmp/repo",
		});

		assert.equal(result?.isError, true);
		const payload = parseToolJson(result);
		assert.equal(payload.ok, false);
		assert.equal(payload.requestedAgentId, "scrum");
		assert.equal(payload.mappingConfigured, true);
		assert.match(payload.error, /no mapping matched/i);
	} finally {
		harness.cleanup();
	}
});
