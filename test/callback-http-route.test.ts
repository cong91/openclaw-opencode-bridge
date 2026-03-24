import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
					requestHeartbeatNow(opts: any) {
						heartbeats.push(opts);
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
		sessionKey: "agent:creator:telegram:direct:5165741309",
		sessionId: "sess-origin-1",
		wakeMode: "now",
		deliver: false,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "session.idle",
			runId: "run-1",
			taskId: "task-1",
			callbackTargetSessionKey: "agent:creator:telegram:direct:5165741309",
			callbackTargetSessionId: "sess-origin-1",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.match(systemEvents[0]?.text, /OpenCode callback control message/);
	assert.match(systemEvents[0]?.text, /<opencode_callback_json>/);
	assert.match(systemEvents[0]?.text, /"messageKind":"callback_control"/);
	assert.match(systemEvents[0]?.text, /"runId":"run-1"/);
	assert.equal(systemEvents[0]?.opts?.sessionKey, payload.sessionKey);
	assert.equal(systemEvents[0]?.opts?.sessionId, payload.sessionId);
	assert.equal(
		systemEvents[0]?.opts?.contextKey,
		"opencode:run-1:session.idle",
	);
	assert.equal(heartbeats.length, 1);
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
