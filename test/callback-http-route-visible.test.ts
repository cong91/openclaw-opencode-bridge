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

test("callback http route enqueues callback, wakes session, and sends visible telegram ack when deliver=true", async () => {
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
	assert.equal(systemEvents.length, 2);
	assert.match(systemEvents[0].text, /OpenCode callback control message/);
	assert.match(systemEvents[0].text, /"messageKind":"callback_control"/);
	assert.equal(systemEvents[0]?.opts?.sessionId, payload.sessionId);
	assert.match(
		systemEvents[1].text,
		/OpenCode callback received for run run-visible-1/,
	);
	assert.equal(systemEvents[1]?.opts?.sessionId, payload.sessionId);
	assert.equal(heartbeatCalls.length, 1);
	assert.equal(heartbeatCalls[0]?.sessionKey, payload.sessionKey);
	assert.equal(heartbeatCalls[0]?.sessionId, payload.sessionId);
	assert.equal(heartbeatCalls[0]?.agentId, payload.agentId);
	assert.equal(telegramSends.length, 1);
	assert.equal(telegramSends[0]?.to, "5165741309");
	assert.match(
		telegramSends[0]?.text,
		/OpenCode callback received for run run-visible-1/,
	);
	assert.equal(telegramSends[0]?.opts?.silent, false);
});
