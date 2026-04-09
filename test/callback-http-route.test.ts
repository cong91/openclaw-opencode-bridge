import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
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

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredRoute = {
	path: string;
	auth: "gateway" | "plugin";
	handler: (req: any, res: any) => Promise<boolean>;
};

function createMockReq(
	body: string,
	token: string,
	authMode: "bearer" | "legacy" = "bearer",
) {
	const req = new EventEmitter() as any;
	req.method = "POST";
	req.url = "/plugin/opencode-bridge/callback";
	req.headers =
		authMode === "legacy"
			? { "x-openclaw-token": token }
			: { authorization: `Bearer ${token}` };
	process.nextTick(() => {
		req.emit("data", Buffer.from(body, "utf8"));
		req.emit("end");
	});
	return req;
}

function createMockRes() {
	return {
		statusCode: 200,
		headers: {} as Record<string, string>,
		body: "",
		setHeader(name: string, value: string) {
			this.headers[name] = value;
		},
		end(chunk?: string) {
			if (chunk) this.body += chunk;
		},
	} as any;
}

function swallowSpawnEnoent(error: any) {
	if (
		error?.code === "ENOENT" &&
		String(error?.message || "").includes("spawn opencode")
	) {
		return;
	}
	throw error;
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

test("callback http route enqueues callback message into target session and wakes heartbeat", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: Array<{ text: string; opts: any }> = [];
	const heartbeats: any[] = [];

	registerOpenCodeBridgeTools(
		{
			registerTool() {},
			registerHttpRoute(route: RegisteredRoute) {
				routes.push(route);
			},
			runtime: {
				system: {
					enqueueSystemEvent(text: string, opts: any) {
						systemEvents.push({ text, opts });
						return true;
					},
				},
			},
		},
		{
			hookToken: "test-token",
		},
	);

	const route = routes.find(
		(x) => x.path === "/plugin/opencode-bridge/callback",
	);
	assert.ok(route, "callback route should be registered");
	assert.equal(route?.auth, "plugin");

	const payload = {
		name: "OpenCode",
		agentId: "creator",
		sessionKey: "agent:creator:opencode:creator:callback:run-1",
		sessionId: "sess-origin-1",
		wakeMode: "now",
		deliver: false,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "session.idle",
			runId: "run-1",
			taskId: "task-1",
			callbackTargetSessionKey: "agent:creator:opencode:creator:callback:run-1",
			callbackTargetSessionId: "sess-origin-1",
			callbackRelaySessionKey: "agent:creator:telegram:direct:5165741309",
			callbackRelaySessionId: "sess-origin-1",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.match(systemEvents[0]?.text, /<opencode_callback_control_internal>/);
	assert.doesNotMatch(
		systemEvents[0]?.text,
		/OpenCode callback control message/,
	);
	assert.match(systemEvents[0]?.text, /"messageKind":"callback_control"/);
	assert.match(systemEvents[0]?.text, /"runId":"run-1"/);
	assert.equal(systemEvents[0]?.opts?.sessionKey, payload.sessionKey);
	assert.equal(systemEvents[0]?.opts?.sessionId, undefined);
	assert.equal(
		systemEvents[0]?.opts?.contextKey,
		"opencode:run-1:session.idle:agent:creator:opencode:creator:callback:run-1:callback_control",
	);
});

test("callback http route materializes terminal run artifact on message.updated callback", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-callback-"));
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	const runsDir = join(bridgeDir, "runs");
	mkdirSync(runsDir, { recursive: true });
	const runId = "run-terminal-1";
	const runPath = join(runsDir, `${runId}.json`);
	const initialUpdatedAt = "2000-01-01T00:00:00.000Z";
	writeFileSync(
		runPath,
		JSON.stringify(
			{
				taskId: "task-terminal-1",
				runId,
				state: "running",
				lastEvent: "task.progress",
				lastSummary:
					"Attach-run dispatched; terminal callback owned by OpenCode-side plugin",
				updatedAt: initialUpdatedAt,
				envelope: {
					task_id: "task-terminal-1",
					run_id: runId,
					agent_id: "builder",
					requested_agent_id: "creator",
					resolved_agent_id: "builder",
					session_key: "hook:opencode:builder:task-terminal-1",
					origin_session_key: "session:origin:terminal-1",
					callback_target_session_key: "session:origin:terminal-1",
					project_id: "proj-terminal-1",
					repo_root: "/tmp/repo-terminal-1",
					opencode_server_url: "http://opencode.local",
				},
			},
			null,
			2,
		),
		"utf8",
	);

	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	const routes: RegisteredRoute[] = [];
	registerOpenCodeBridgeTools(
		{
			registerTool() {},
			registerHttpRoute(route: RegisteredRoute) {
				routes.push(route);
			},
			runtime: {
				system: {
					enqueueSystemEvent() {
						return true;
					},
					requestHeartbeatNow() {},
				},
			},
		},
		{
			hookToken: "test-token",
		},
	);

	try {
		const route = routes.find(
			(x) => x.path === "/plugin/opencode-bridge/callback",
		);
		assert.ok(route, "callback route should be registered");

		const payload = {
			name: "OpenCode",
			agentId: "creator",
			sessionKey: "session:origin:terminal-1",
			wakeMode: "now",
			deliver: false,
			message: JSON.stringify({
				kind: "opencode.callback",
				eventType: "message.updated",
				runId,
				taskId: "task-terminal-1",
				callbackTargetSessionKey: "session:origin:terminal-1",
			}),
		};

		const req = createMockReq(JSON.stringify(payload), "test-token");
		const res = createMockRes();
		const handled = await route!.handler(req, res);

		assert.equal(handled, true);
		assert.equal(res.statusCode, 200);

		const persisted = JSON.parse(readFileSync(runPath, "utf8"));
		assert.equal(persisted.state, "completed");
		assert.equal(persisted.lastEvent, "task.completed");
		assert.match(
			String(persisted.lastSummary || ""),
			/Terminal callback materialized/,
		);
		assert.equal(persisted.callbackStatus, 200);
		assert.equal(persisted.callbackOk, true);
		assert.equal(typeof persisted.callbackBody, "string");
		assert.match(String(persisted.callbackBody), /"ok":true/);
		assert.match(
			String(persisted.callbackBody),
			/"eventType":"message.updated"/,
		);
		assert.notEqual(persisted.updatedAt, initialUpdatedAt);
	} finally {
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("callback http route finalizes terminal artifact on first session.idle callback without prior callbackOk", async () => {
	const tempRoot = mkdtempSync(
		join(tmpdir(), "opencode-bridge-callback-idle-first-"),
	);
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	const runsDir = join(bridgeDir, "runs");
	mkdirSync(runsDir, { recursive: true });
	const runId = "run-terminal-idle-first-1";
	const runPath = join(runsDir, `${runId}.json`);
	writeFileSync(
		runPath,
		JSON.stringify(
			{
				taskId: "task-terminal-idle-first-1",
				runId,
				state: "running",
				lastEvent: "task.progress",
				lastSummary:
					"Attach-run dispatched; terminal callback owned by OpenCode-side plugin",
				updatedAt: "2000-01-01T00:00:00.000Z",
				envelope: {
					task_id: "task-terminal-idle-first-1",
					run_id: runId,
					agent_id: "builder",
					requested_agent_id: "creator",
					resolved_agent_id: "builder",
					session_key: "hook:opencode:builder:task-terminal-idle-first-1",
					origin_session_key: "session:origin:terminal-idle-first-1",
					callback_target_session_key: "session:origin:terminal-idle-first-1",
					project_id: "proj-terminal-idle-first-1",
					repo_root: "/tmp/repo-terminal-idle-first-1",
					opencode_server_url: "http://opencode.local",
				},
			},
			null,
			2,
		),
		"utf8",
	);

	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	const routes: RegisteredRoute[] = [];
	registerOpenCodeBridgeTools(
		{
			registerTool() {},
			registerHttpRoute(route: RegisteredRoute) {
				routes.push(route);
			},
			runtime: {
				system: {
					enqueueSystemEvent() {
						return true;
					},
					requestHeartbeatNow() {},
				},
			},
		},
		{
			hookToken: "test-token",
		},
	);

	try {
		const route = routes.find(
			(x) => x.path === "/plugin/opencode-bridge/callback",
		);
		assert.ok(route, "callback route should be registered");

		const req = createMockReq(
			JSON.stringify({
				name: "OpenCode",
				agentId: "creator",
				sessionKey: "session:origin:terminal-idle-first-1",
				wakeMode: "now",
				deliver: false,
				message: JSON.stringify({
					kind: "opencode.callback",
					eventType: "session.idle",
					runId,
					taskId: "task-terminal-idle-first-1",
					callbackTargetSessionKey: "session:origin:terminal-idle-first-1",
				}),
			}),
			"test-token",
		);
		const res = createMockRes();
		const handled = await route!.handler(req, res);

		assert.equal(handled, true);
		assert.equal(res.statusCode, 200);

		const persisted = JSON.parse(readFileSync(runPath, "utf8"));
		assert.equal(persisted.state, "completed");
		assert.equal(persisted.lastEvent, "task.completed");
		assert.match(
			String(persisted.lastSummary || ""),
			/Terminal callback materialized \(session.idle\)/,
		);
		assert.equal(persisted.callbackStatus, 200);
		assert.equal(persisted.callbackOk, true);
	} finally {
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("callback http route keeps run completed when message.updated is followed by session.idle", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-callback-seq-"));
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	const runsDir = join(bridgeDir, "runs");
	mkdirSync(runsDir, { recursive: true });
	const runId = "run-terminal-seq-1";
	const runPath = join(runsDir, `${runId}.json`);
	writeFileSync(
		runPath,
		JSON.stringify(
			{
				taskId: "task-terminal-seq-1",
				runId,
				state: "running",
				lastEvent: null,
				lastSummary:
					"Attach-run dispatched; terminal callback owned by OpenCode-side plugin",
				updatedAt: "2000-01-01T00:00:00.000Z",
				envelope: {
					task_id: "task-terminal-seq-1",
					run_id: runId,
					agent_id: "builder",
					requested_agent_id: "creator",
					resolved_agent_id: "builder",
					session_key: "hook:opencode:builder:task-terminal-seq-1",
					origin_session_key: "session:origin:terminal-seq-1",
					callback_target_session_key: "session:origin:terminal-seq-1",
					project_id: "proj-terminal-seq-1",
					repo_root: "/tmp/repo-terminal-seq-1",
					opencode_server_url: "http://opencode.local",
				},
			},
			null,
			2,
		),
		"utf8",
	);

	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	const routes: RegisteredRoute[] = [];
	registerOpenCodeBridgeTools(
		{
			registerTool() {},
			registerHttpRoute(route: RegisteredRoute) {
				routes.push(route);
			},
			runtime: {
				system: {
					enqueueSystemEvent() {
						return true;
					},
					requestHeartbeatNow() {},
				},
			},
		},
		{
			hookToken: "test-token",
		},
	);

	try {
		const route = routes.find(
			(x) => x.path === "/plugin/opencode-bridge/callback",
		);
		assert.ok(route, "callback route should be registered");

		const basePayload = {
			name: "OpenCode",
			agentId: "creator",
			sessionKey: "session:origin:terminal-seq-1",
			wakeMode: "now",
			deliver: false,
		};

		const messageUpdatedReq = createMockReq(
			JSON.stringify({
				...basePayload,
				message: JSON.stringify({
					kind: "opencode.callback",
					eventType: "message.updated",
					runId,
					taskId: "task-terminal-seq-1",
					callbackTargetSessionKey: "session:origin:terminal-seq-1",
				}),
			}),
			"test-token",
		);
		const messageUpdatedRes = createMockRes();
		const handledUpdated = await route!.handler(
			messageUpdatedReq,
			messageUpdatedRes,
		);
		assert.equal(handledUpdated, true);
		assert.equal(messageUpdatedRes.statusCode, 200);

		let persisted = JSON.parse(readFileSync(runPath, "utf8"));
		assert.equal(persisted.state, "completed");
		assert.equal(persisted.lastEvent, "task.completed");

		const sessionIdleReq = createMockReq(
			JSON.stringify({
				...basePayload,
				message: JSON.stringify({
					kind: "opencode.callback",
					eventType: "session.idle",
					runId,
					taskId: "task-terminal-seq-1",
					callbackTargetSessionKey: "session:origin:terminal-seq-1",
				}),
			}),
			"test-token",
		);
		const sessionIdleRes = createMockRes();
		const handledIdle = await route!.handler(sessionIdleReq, sessionIdleRes);
		assert.equal(handledIdle, true);
		assert.equal(sessionIdleRes.statusCode, 200);

		persisted = JSON.parse(readFileSync(runPath, "utf8"));
		assert.equal(persisted.state, "completed");
		assert.equal(persisted.lastEvent, "task.completed");
		assert.match(
			String(persisted.lastSummary || ""),
			/Terminal callback materialized/,
		);
		assert.equal(persisted.callbackStatus, 200);
		assert.equal(persisted.callbackOk, true);
		assert.match(
			String(persisted.callbackBody || ""),
			/"eventType":"session.idle"/,
		);
	} finally {
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("workflow policy callback auto-launches next isolated run once and dedupes duplicate callback", async () => {
	const fixedNow = 1_700_000_000_000;
	const originalNow = Date.now;
	Date.now = () => fixedNow;

	const workflowId = "wf-policy-1";
	const expectedTaskId = `${workflowId}:review:1`;
	const expectedChildRunId = `${expectedTaskId}-${fixedNow}`;
	const repoRoot = "/tmp/repo-policy-1";
	mkdirSync(repoRoot, { recursive: true });

	const mock = await withMockServer((req, res) => {
		const url = req.url || "/";
		if (url === "/session") {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify([
					{
						id: "sess-policy-child-1",
						title: `runId=${expectedChildRunId} repoRoot=${repoRoot}`,
					},
				]),
			);
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	});

	const tempRoot = mkdtempSync(
		join(tmpdir(), "opencode-bridge-callback-policy-"),
	);
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	const runsDir = join(bridgeDir, "runs");
	mkdirSync(runsDir, { recursive: true });

	const parentRunId = "run-policy-parent-1";
	const parentRunPath = join(runsDir, `${parentRunId}.json`);
	writeFileSync(
		parentRunPath,
		JSON.stringify(
			{
				taskId: "task-policy-parent-1",
				runId: parentRunId,
				state: "running",
				lastEvent: "task.progress",
				lastSummary:
					"Attach-run dispatched; terminal callback owned by OpenCode-side plugin",
				updatedAt: "2000-01-01T00:00:00.000Z",
				envelope: {
					task_id: "task-policy-parent-1",
					run_id: parentRunId,
					agent_id: "build",
					requested_agent_id: "creator",
					resolved_agent_id: "build",
					session_key: "hook:opencode:build:task-policy-parent-1",
					origin_session_key: "session:origin:policy-1",
					callback_target_session_key: "session:origin:policy-1",
					project_id: "proj-policy-1",
					repo_root: repoRoot,
					opencode_server_url: mock.baseUrl,
				},
				continuation: {
					workflowId,
					workflowType: "small-fix",
					policyVersion: "2026-04-09-v1",
					stepId: "step-implement-1",
					currentIntent: "implement",
					currentExecutionLane: "build",
					callbackEventKind: "opencode.callback",
					promptVariant: "medium",
					thinking: true,
					workflow: {
						workflowId,
						workflowType: "small-fix",
						policyVersion: "2026-04-09-v1",
						objective: "Implement policy callback chain",
						currentStep: {
							stepId: "step-implement-1",
							intent: "implement",
							executionLane: "build",
							status: "running",
						},
						transitionCount: 0,
						maxTransitions: 6,
					},
				},
			},
			null,
			2,
		),
		"utf8",
	);

	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	const prevPath = process.env.PATH;
	process.env.OPENCLAW_STATE_DIR = stateDir;
	const binDir = join(tempRoot, "bin");
	mkdirSync(binDir, { recursive: true });
	const fakeOpencode = join(binDir, "opencode");
	writeFileSync(fakeOpencode, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(fakeOpencode, 0o755);
	process.env.PATH = `${binDir}:${prevPath || ""}`;

	const routes: RegisteredRoute[] = [];
	const systemEvents: Array<{ text: string; opts: any }> = [];
	registerOpenCodeBridgeTools(
		{
			registerTool() {},
			registerHttpRoute(route: RegisteredRoute) {
				routes.push(route);
			},
			runtime: {
				system: {
					enqueueSystemEvent(text: string, opts: any) {
						systemEvents.push({ text, opts });
						return true;
					},
				},
			},
		},
		{ hookToken: "test-token" },
	);

	try {
		const route = routes.find(
			(x) => x.path === "/plugin/opencode-bridge/callback",
		);
		assert.ok(route, "callback route should be registered");

		const payload = {
			name: "OpenCode",
			agentId: "creator",
			sessionKey: "session:origin:policy-1",
			wakeMode: "now",
			deliver: false,
			message: JSON.stringify({
				kind: "opencode.callback",
				eventType: "task.completed",
				runId: parentRunId,
				taskId: "task-policy-parent-1",
				callbackTargetSessionKey: "session:origin:policy-1",
			}),
		};

		const firstReq = createMockReq(JSON.stringify(payload), "test-token");
		const firstRes = createMockRes();
		const firstHandled = await route!.handler(firstReq, firstRes);
		assert.equal(firstHandled, true);
		assert.equal(firstRes.statusCode, 200);

		const secondReq = createMockReq(JSON.stringify(payload), "test-token");
		const secondRes = createMockRes();
		const secondHandled = await route!.handler(secondReq, secondRes);
		assert.equal(secondHandled, true);
		assert.equal(secondRes.statusCode, 200);

		const runFiles = readdirSync(runsDir).filter((x) => x.endsWith(".json"));
		assert.equal(runFiles.includes(`${expectedChildRunId}.json`), true);
		assert.equal(
			runFiles.length,
			2,
			"duplicate callback must not create 2nd child run",
		);

		const parentPersisted = JSON.parse(readFileSync(parentRunPath, "utf8"));
		assert.equal(
			parentPersisted.continuation?.workflow?.nextTransition?.action,
			"launch_run",
		);
		assert.equal(
			parentPersisted.continuation?.workflow?.nextTransition?.launched,
			true,
		);
		assert.match(
			String(
				parentPersisted.continuation?.workflow?.nextTransition?.dedupeKey || "",
			),
			/task.completed/,
		);

		const childPersisted = JSON.parse(
			readFileSync(join(runsDir, `${expectedChildRunId}.json`), "utf8"),
		);
		assert.equal(childPersisted.envelope?.resolved_agent_id, "review");
		assert.equal(
			childPersisted.continuation?.workflow?.currentStep?.intent,
			"review",
		);
		assert.equal(
			childPersisted.continuation?.workflow?.currentStep?.executionLane,
			"review",
		);
		assert.equal(systemEvents.length >= 2, true);
	} finally {
		Date.now = originalNow;
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		if (prevPath === undefined) delete process.env.PATH;
		else process.env.PATH = prevPath;
		await mock.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
