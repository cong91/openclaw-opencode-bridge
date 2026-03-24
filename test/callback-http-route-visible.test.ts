import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

test("callback http route enqueues control message, wakes session, and sends direct telegram ack when deliver=true", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: any[] = [];
	const heartbeatCalls: any[] = [];
	const telegramSends: any[] = [];

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
				channel: {
					telegram: {
						async sendMessageTelegram(to: string, text: string, opts: any) {
							telegramSends.push({ to, text, opts });
							return { ok: true, channel: "telegram", to };
						},
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

	const payload = {
		name: "OpenCode",
		agentId: "creator",
		sessionKey: "agent:creator:telegram:direct:5165741309",
		sessionId: "sess-origin-1",
		wakeMode: "now",
		deliver: true,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "message.updated",
			runId: "run-visible-1",
			taskId: "task-visible-1",
			callbackTargetSessionKey: "agent:creator:telegram:direct:5165741309",
			callbackTargetSessionId: "sess-origin-1",
			opencodeSessionId: "oc-sess-1",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.match(systemEvents[0].text, /OpenCode callback control message/);
	assert.match(systemEvents[0].text, /"messageKind":"callback_control"/);
	assert.equal(systemEvents[0]?.opts?.sessionId, payload.sessionId);
	assert.doesNotMatch(
		systemEvents[0].text,
		/OpenCode callback received for run run-visible-1; code finished; agent is continuing\./,
	);
	assert.equal(heartbeatCalls.length, 1);
	assert.equal(heartbeatCalls[0]?.sessionKey, payload.sessionKey);
	assert.equal(heartbeatCalls[0]?.sessionId, payload.sessionId);
	assert.equal(heartbeatCalls[0]?.agentId, payload.agentId);
	assert.equal(telegramSends.length, 1);
	assert.equal(telegramSends[0]?.to, "5165741309");
	assert.match(
		telegramSends[0]?.text,
		/OpenCode callback received for run run-visible-1; code finished; agent is continuing\./,
	);
	assert.equal(telegramSends[0]?.opts?.silent, false);
});

test("callback http route sends direct telegram ack even when deliver=false", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: any[] = [];
	const heartbeatCalls: any[] = [];
	const telegramSends: any[] = [];

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
				channel: {
					telegram: {
						async sendMessageTelegram(to: string, text: string, opts: any) {
							telegramSends.push({ to, text, opts });
							return { ok: true, channel: "telegram", to };
						},
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

	const payload = {
		name: "OpenCode",
		agentId: "creator",
		sessionKey: "agent:creator:telegram:direct:5165741309",
		sessionId: "sess-origin-2",
		wakeMode: "now",
		deliver: false,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "message.updated",
			runId: "run-visible-2",
			taskId: "task-visible-2",
			callbackTargetSessionKey: "agent:creator:telegram:direct:5165741309",
			callbackTargetSessionId: "sess-origin-2",
			opencodeSessionId: "oc-sess-2",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.match(systemEvents[0].text, /OpenCode callback control message/);
	assert.equal(heartbeatCalls.length, 1);
	assert.equal(heartbeatCalls[0]?.sessionKey, payload.sessionKey);
	assert.equal(heartbeatCalls[0]?.sessionId, payload.sessionId);
	assert.equal(heartbeatCalls[0]?.agentId, payload.agentId);
	assert.equal(telegramSends.length, 1);
	assert.equal(telegramSends[0]?.to, "5165741309");
	assert.match(
		telegramSends[0]?.text,
		/OpenCode callback received for run run-visible-2; code finished; agent is continuing\./,
	);
	assert.equal(telegramSends[0]?.opts?.silent, false);
});

test("callback http route does not send telegram ack for telegram group session", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: any[] = [];
	const heartbeatCalls: any[] = [];
	const telegramSends: any[] = [];

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
				channel: {
					telegram: {
						async sendMessageTelegram(to: string, text: string, opts: any) {
							telegramSends.push({ to, text, opts });
							return { ok: true, channel: "telegram", to };
						},
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

	const payload = {
		name: "OpenCode",
		agentId: "creator",
		sessionKey: "agent:creator:telegram:group:-10011223344",
		sessionId: "sess-group-1",
		wakeMode: "now",
		deliver: false,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "message.updated",
			runId: "run-group-1",
			taskId: "task-group-1",
			callbackTargetSessionKey: "agent:creator:telegram:group:-10011223344",
			callbackTargetSessionId: "sess-group-1",
			opencodeSessionId: "oc-sess-group-1",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.match(systemEvents[0].text, /OpenCode callback control message/);
	assert.equal(heartbeatCalls.length, 1);
	assert.equal(heartbeatCalls[0]?.sessionKey, payload.sessionKey);
	assert.equal(heartbeatCalls[0]?.sessionId, payload.sessionId);
	assert.equal(telegramSends.length, 0);
});
