import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredRoute = {
	path: string;
	auth: "gateway" | "plugin";
	handler: (req: any, res: any) => Promise<boolean>;
};

function createMockReq(body: string, token: string) {
	const req = new EventEmitter() as any;
	req.method = "POST";
	req.url = "/plugin/opencode-bridge/callback";
	req.headers = { authorization: `Bearer ${token}` };
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

test("callback route prefers callbackTargetSessionId over lane-only routing metadata", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: Array<{ text: string; opts: any }> = [];
	const heartbeatCalls: any[] = [];

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
						heartbeatCalls.push(opts);
					},
				},
			},
		},
		{ hookToken: "test-token" },
	);

	const route = routes.find(
		(x) => x.path === "/plugin/opencode-bridge/callback",
	);
	assert.ok(route, "callback route should be registered");

	const payload = {
		name: "OpenCode",
		agentId: "creator",
		sessionKey: "agent:creator:telegram:direct:5165741309",
		sessionId: "stale-lane-session-id",
		wakeMode: "now",
		deliver: false,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "task.completed",
			runId: "run-exact-session-1",
			taskId: "task-exact-session-1",
			callbackTargetSessionKey: "agent:creator:telegram:direct:5165741309",
			callbackTargetSessionId: "exact-requester-session-id",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.equal(systemEvents[0]?.opts?.sessionKey, payload.sessionKey);
	assert.equal(systemEvents[0]?.opts?.sessionId, "exact-requester-session-id");
	assert.equal(heartbeatCalls.length, 1);
	assert.equal(heartbeatCalls[0]?.sessionKey, payload.sessionKey);
	assert.equal(heartbeatCalls[0]?.sessionId, "exact-requester-session-id");
	assert.equal(heartbeatCalls[0]?.agentId, payload.agentId);
});

test("callback route falls back to payload sessionId when callbackTargetSessionId metadata is absent", async () => {
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
					requestHeartbeatNow() {},
				},
			},
		},
		{ hookToken: "test-token" },
	);

	const route = routes.find(
		(x) => x.path === "/plugin/opencode-bridge/callback",
	);
	assert.ok(route, "callback route should be registered");

	const payload = {
		name: "OpenCode",
		agentId: "creator",
		sessionKey: "agent:creator:telegram:direct:5165741309",
		sessionId: "payload-session-id-only",
		wakeMode: "now",
		deliver: false,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "task.completed",
			runId: "run-exact-session-2",
			taskId: "task-exact-session-2",
			callbackTargetSessionKey: "agent:creator:telegram:direct:5165741309",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.equal(systemEvents[0]?.opts?.sessionId, "payload-session-id-only");
});

test("callback route derives heartbeat agentId from agent sessionKey when payload agentId is missing", async () => {
	const routes: RegisteredRoute[] = [];
	const heartbeatCalls: any[] = [];

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
					requestHeartbeatNow(opts: any) {
						heartbeatCalls.push(opts);
					},
				},
			},
		},
		{ hookToken: "test-token" },
	);

	const route = routes.find(
		(x) => x.path === "/plugin/opencode-bridge/callback",
	);
	assert.ok(route, "callback route should be registered");

	const payload = {
		name: "OpenCode",
		sessionKey: "agent:builder:telegram:direct:5165741309",
		sessionId: "session-derived-agent-1",
		wakeMode: "now",
		deliver: false,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "task.completed",
			runId: "run-derived-agent-1",
			taskId: "task-derived-agent-1",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(heartbeatCalls.length, 1);
	assert.equal(heartbeatCalls[0]?.sessionKey, payload.sessionKey);
	assert.equal(heartbeatCalls[0]?.sessionId, payload.sessionId);
	assert.equal(heartbeatCalls[0]?.agentId, "builder");
});
