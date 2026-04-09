import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerOpenCodeBridgeTools } from "../src/registrar";

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

async function withMockServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
	const server = createServer(handler);
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const baseUrl = `http://127.0.0.1:${port}`;
	return {
		baseUrl,
		close: async () => {
			await new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			);
		},
	};
}

function setupHarness(configFile: any) {
	const tempRoot = mkdtempSync(
		join(tmpdir(), "opencode-bridge-workflow-status-"),
	);
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
		stateDir,
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

function seedWorkflowArtifact(
	stateDir: string,
	runId: string,
	baseUrl: string,
) {
	const runsDir = join(stateDir, "opencode-bridge", "runs");
	mkdirSync(runsDir, { recursive: true });
	writeFileSync(
		join(runsDir, `${runId}.json`),
		JSON.stringify(
			{
				taskId: "task-workflow-status-1",
				runId,
				state: "running",
				updatedAt: new Date().toISOString(),
				envelope: {
					task_id: "task-workflow-status-1",
					run_id: runId,
					agent_id: "build",
					requested_agent_id: "creator",
					resolved_agent_id: "build",
					session_key: "hook:opencode:build:task-workflow-status-1",
					origin_session_key: "session:origin:workflow-status-1",
					callback_target_session_key: "session:origin:workflow-status-1",
					callback_target_session_id: "sess-workflow-status-1",
					project_id: "proj-workflow-status",
					repo_root: "/tmp/repo-workflow-status",
					opencode_server_url: baseUrl,
				},
				continuation: {
					workflowId: "wf-workflow-status-1",
					workflowType: "small-fix",
					policyVersion: "2026-04-09-v1",
					stepId: "step-implement-1",
					currentIntent: "implement",
					currentExecutionLane: "build",
					callbackEventKind: "opencode.callback",
					workflow: {
						workflowId: "wf-workflow-status-1",
						workflowType: "small-fix",
						policyVersion: "2026-04-09-v1",
						currentStep: {
							stepId: "step-implement-1",
							intent: "implement",
							executionLane: "build",
							status: "running",
						},
						previousOutcome: "success",
						transitionCount: 1,
						nextTransition: {
							action: "launch_run",
							reason: "policy_transition:implement:success->review",
							launched: true,
							nextStep: {
								stepId: "step-review-1",
								intent: "review",
								executionLane: "review",
								status: "running",
							},
						},
					},
				},
			},
			null,
			2,
		),
		"utf8",
	);
}

test("run_status exposes workflow and workflowStatus surfaces", async () => {
	const runId = "run-workflow-status-1";
	const mock = await withMockServer((req, res) => {
		const url = req.url || "/";
		if (url === "/global/health") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ healthy: true, version: "test" }));
			return;
		}
		if (url === "/session") {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify([
					{
						id: "sess-workflow-status-1",
						metadata: { session_key: "session:origin:workflow-status-1" },
					},
				]),
			);
			return;
		}
		if (url === "/session/status") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: true }));
			return;
		}
		if (url === "/event") {
			res.setHeader("content-type", "text/event-stream");
			res.end(
				[
					"event: message",
					'data: {"type":"task.progress","run_id":"run-workflow-status-1"}',
					"",
				].join("\n"),
			);
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	});

	const harness = setupHarness({
		opencodeServerUrl: mock.baseUrl,
		projectRegistry: [],
	});
	try {
		seedWorkflowArtifact(harness.stateDir, runId, mock.baseUrl);
		const tool = harness.tools.get("opencode_run_status");
		assert.ok(tool, "opencode_run_status should be registered");

		const result = await tool!.execute("test", {
			runId,
			opencodeServerUrl: mock.baseUrl,
		});
		const payload = parseToolJson(result);

		assert.equal(payload.ok, true);
		assert.equal(payload.workflow?.workflowType, "small-fix");
		assert.equal(payload.workflowStatus?.currentStepIntent, "implement");
		assert.equal(payload.workflowStatus?.currentExecutionLane, "build");
		assert.equal(payload.workflowStatus?.nextAction, "launch_run");
		assert.equal(payload.workflowStatus?.nextStepIntent, "review");
		assert.equal(payload.workflowStatus?.nextExecutionLane, "review");
	} finally {
		await mock.close();
		harness.cleanup();
	}
});

test("run_events and session_tail expose workflowStatus surfaces", async () => {
	const runId = "run-workflow-status-2";
	const mock = await withMockServer((req, res) => {
		const url = req.url || "/";
		if (url === "/session") {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify([
					{
						id: "sess-workflow-status-2",
						metadata: { session_key: "session:origin:workflow-status-1" },
					},
				]),
			);
			return;
		}
		if (url === "/event") {
			res.setHeader("content-type", "text/event-stream");
			res.end(
				[
					"event: message",
					`data: {"type":"task.progress","run_id":"${runId}"}`,
					"",
				].join("\n"),
			);
			return;
		}
		if (url === "/session/sess-workflow-status-2/message") {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify([
					{
						info: { id: "m1", role: "assistant", time: { created: 1 } },
						parts: [{ type: "text", text: "tail" }],
					},
				]),
			);
			return;
		}
		if (url === "/session/sess-workflow-status-2/diff") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ files: ["src/registrar.ts"] }));
			return;
		}
		if (url === "/session/sess-workflow-status-2") {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({ id: "sess-workflow-status-2", title: "workflow" }),
			);
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	});

	const harness = setupHarness({
		opencodeServerUrl: mock.baseUrl,
		projectRegistry: [],
	});
	try {
		seedWorkflowArtifact(harness.stateDir, runId, mock.baseUrl);

		const eventsTool = harness.tools.get("opencode_run_events");
		assert.ok(eventsTool, "opencode_run_events should be registered");
		const eventsResult = await eventsTool!.execute("test", {
			runId,
			scope: "session",
			limit: 1,
			timeoutMs: 1200,
			opencodeServerUrl: mock.baseUrl,
		});
		const eventsPayload = parseToolJson(eventsResult);
		assert.equal(eventsPayload.workflowStatus?.currentStepIntent, "implement");
		assert.equal(eventsPayload.workflowStatus?.nextAction, "launch_run");

		const tailTool = harness.tools.get("opencode_session_tail");
		assert.ok(tailTool, "opencode_session_tail should be registered");
		const tailResult = await tailTool!.execute("test", {
			runId,
			limit: 5,
			includeDiff: true,
			opencodeServerUrl: mock.baseUrl,
		});
		const tailPayload = parseToolJson(tailResult);
		assert.equal(tailPayload.workflowStatus?.currentStepIntent, "implement");
		assert.equal(tailPayload.workflowStatus?.nextStepIntent, "review");
	} finally {
		await mock.close();
		harness.cleanup();
	}
});
