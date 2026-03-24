import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as childProcess from "node:child_process";

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredTool = {
	name: string;
	execute: (_id: string, params: any) => Promise<any>;
};

function swallowSpawnEnoent(error: any) {
	if (
		error?.code === "ENOENT" &&
		String(error?.message || "").includes("spawn opencode")
	) {
		return;
	}
	throw error;
}

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
	const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-exec-test-"));
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

test("opencode_execute_task starts execution with plugin-owned callback authority", async () => {
	const callbackRequests: any[] = [];
	let createdSessionCount = 0;
	let promptAsyncCount = 0;
	let eventReadCount = 0;

	const originalFetch = globalThis.fetch;
	const originalPath = process.env.PATH;

	const mock = await withMockServer(async (req, res) => {
		const url = req.url || "/";
		if (req.method === "GET" && url === "/global/health") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ healthy: true, version: "test" }));
			return;
		}
		if (req.method === "GET" && url === "/session") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify([{ id: "sess-exec-1", title: "task-exec-1 runId=run-exec-1 taskId=task-exec-1 requested=creator resolved=creator callbackSession=session:origin:exec-1 callbackSessionId=origin-session-1 callbackDeliver=false projectId=proj-exec-1 repoRoot=" + repoRoot } ]));
			return;
		}
		if (req.method === "GET" && url === "/session/sess-exec-1") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ id: "sess-exec-1", title: "task-exec-1 runId=run-exec-1 taskId=task-exec-1 requested=creator resolved=creator callbackSession=session:origin:exec-1 callbackSessionId=origin-session-1 callbackDeliver=false projectId=proj-exec-1 repoRoot=" + repoRoot }));
			return;
		}
		if (req.method === "GET" && url === "/session/sess-exec-1/message") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify([{ info: { id: "msg_run-exec-1" } }]));
			return;
		}
		if (req.method === "GET" && (url === "/event" || url === "/global/event")) {
			eventReadCount += 1;
			res.setHeader("content-type", "text/event-stream");
			if (eventReadCount === 1) {
				res.end(
					[
						"event: message",
						'data: {"type":"task.progress","run_id":"run-exec-1","task_id":"task-exec-1","session_id":"sess-exec-1","text":"planning progress"}',
						"",
					].join("\n"),
				);
				return;
			}
			res.end(
				[
					"event: message",
					'data: {"type":"task.completed","run_id":"run-exec-1","task_id":"task-exec-1","session_id":"sess-exec-1","text":"done summary"}',
					"",
				].join("\n"),
			);
			return;
		}
		if (req.method === "POST" && url === "/plugin/opencode-bridge/callback") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				callbackRequests.push(JSON.parse(body));
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ ok: true }));
			});
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	});

	const harness = setupHarness({
		opencodeServerUrl: mock.baseUrl,
		hookBaseUrl: mock.baseUrl,
		hookToken: "test-token",
	});
	const repoRoot = join(harness.stateDir, "repo-exec-1");
	mkdirSync(repoRoot, { recursive: true });

	process.on("uncaughtException", swallowSpawnEnoent);

	let spawnedBaseUrl: string | null = null;
	globalThis.fetch = async (input: any, init?: any) => {
		const url = typeof input === "string" ? input : input?.url;
		if (typeof url === "string") {
			if (url.startsWith(mock.baseUrl)) {
				return originalFetch(input, init);
			}
			if (spawnedBaseUrl && url.startsWith(spawnedBaseUrl)) {
				const rewritten = mock.baseUrl + url.slice(spawnedBaseUrl.length);
				return originalFetch(rewritten, init);
			}
			if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
				const m = url.match(/^http:\/\/127\.0\.0\.1:(\d+)\//);
				if (m) spawnedBaseUrl = `http://127.0.0.1:${m[1]}`;
				const rewritten =
					mock.baseUrl + url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "");
				return originalFetch(rewritten, init);
			}
		}
		throw new Error(`unexpected fetch target: ${String(url)}`);
	};

	try {
		const tool = harness.tools.get("opencode_execute_task");
		assert.ok(tool, "opencode_execute_task should be registered");

		const result = await tool!.execute("test", {
			taskId: "task-exec-1",
			runId: "run-exec-1",
			agentId: "creator",
			originSessionKey: "session:origin:exec-1",
			originSessionId: "origin-session-1",
			projectId: "proj-exec-1",
			repoRoot,
			objective: "Implement test task",
			workflowId: "wf-exec-1",
			stepId: "step-exec-1",
			nextOnSuccess: {
				action: "notify",
				taskId: "task-next-success",
			},
			nextOnFailure: {
				action: "launch_run",
				taskId: "task-next-failure",
				objective: "Handle failure",
			},
			pollIntervalMs: 50,
			maxWaitMs: 1500,
		});
		const payload = parseToolJson(result);

		assert.equal(payload.ok, true);
		assert.equal(payload.execution.sessionId, undefined);
		assert.equal(payload.execution.callbackAuthority, "opencode_plugin");
		assert.equal(payload.execution.continuationEnabled, true);

		await new Promise((resolve) => setTimeout(resolve, 300));

		const runPath = join(
			harness.stateDir,
			"opencode-bridge",
			"runs",
			"run-exec-1.json",
		);
		assert.equal(existsSync(runPath), true);
		const runStatus = JSON.parse(readFileSync(runPath, "utf8"));
		assert.equal(runStatus.state, "running");
		assert.equal(runStatus.executionLane, "attach_run");
		assert.equal(runStatus.continuation.workflowId, "wf-exec-1");
		assert.equal(runStatus.continuation.stepId, "step-exec-1");
		assert.equal(runStatus.continuation.callbackEventKind, "opencode.callback");
		assert.equal(runStatus.continuation.nextOnSuccess.action, "notify");
		assert.equal(runStatus.continuation.nextOnFailure.action, "launch_run");
		assert.equal(createdSessionCount, 0);
		assert.equal(promptAsyncCount, 0);
		assert.match(
			runStatus.lastSummary,
			/Attach-run dispatched/,
		);
		assert.equal(runStatus.callbackOk, undefined);
		assert.equal(runStatus.callbackSentAt, undefined);
		assert.equal(runStatus.callbackAttempts, undefined);

		assert.equal(callbackRequests.length, 0);
		assert.equal(runStatus.attachRun?.command, "opencode");
		assert.ok(runStatus.attachRun?.args.includes("--attach"));
		assert.ok((runStatus.attachRun?.args || []).some((arg: string) => /^http:\/\/127\.0\.0\.1:\d+$/.test(arg)));
		assert.ok(runStatus.attachRun?.args.includes("--dir"));
		assert.ok(runStatus.attachRun?.args.includes(repoRoot));
		assert.ok(runStatus.attachRun?.args.includes("--variant"));
		assert.ok(runStatus.attachRun?.args.includes("medium"));

		const auditPath = join(
			harness.stateDir,
			"opencode-bridge",
			"audit",
			"callbacks.jsonl",
		);
		assert.equal(existsSync(auditPath), false);
	} finally {
		globalThis.fetch = originalFetch;
		process.env.PATH = originalPath;
		process.off("uncaughtException", swallowSpawnEnoent);
		await mock.close();
		harness.cleanup();
	}
});
