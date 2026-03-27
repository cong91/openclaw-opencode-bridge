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
	req.headers = {
		authorization: `Bearer ${token}`,
	};
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

test("pragmatic smoke: callback arrives, session wakes, and no direct telegram ingress notify is sent", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: Array<{ text: string; opts: any }> = [];
	const heartbeats: any[] = [];
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
						heartbeats.push(opts);
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
		sessionKey: "agent:creator:opencode:creator:callback:sess-pragmatic-1",
		sessionId: "sess-pragmatic-1",
		wakeMode: "now",
		deliver: true,
		channel: "telegram",
		to: "5165741309",
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "task.completed",
			runId: "run-pragmatic-1",
			taskId: "task-pragmatic-1",
			callbackTargetSessionKey:
				"agent:creator:opencode:creator:callback:sess-pragmatic-1",
			callbackTargetSessionId: "sess-pragmatic-1",
			callbackRelaySessionKey: "agent:creator:telegram:direct:5165741309",
			callbackRelaySessionId: "sess-pragmatic-1",
			opencodeSessionId: "oc-sess-pragmatic-1",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.equal(systemEvents[0]?.opts?.sessionKey, payload.sessionKey);
	assert.match(systemEvents[0]?.text, /<opencode_callback_control_internal>/);
	assert.doesNotMatch(
		systemEvents[0]?.text,
		/OpenCode callback control message/,
	);
	assert.match(systemEvents[0]?.text, /"messageKind":"callback_control"/);
	assert.equal(
		systemEvents[0]?.opts?.contextKey,
		"opencode:run-pragmatic-1:task.completed:agent:creator:opencode:creator:callback:sess-pragmatic-1:callback_control",
	);
	assert.equal(telegramSends.length, 0);
});
