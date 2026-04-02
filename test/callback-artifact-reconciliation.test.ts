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

test("callback ingress reconciles run artifact from running to completed when callback is accepted", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-reconcile-"));
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	const runsDir = join(bridgeDir, "runs");
	mkdirSync(runsDir, { recursive: true });

	const runId = "vaa24-image-catalog-20260324t2031";
	const attachPid = 43210;
	const runPath = join(runsDir, `${runId}.json`);
	writeFileSync(
		runPath,
		JSON.stringify(
			{
				taskId: "VAA-24-image-catalog",
				runId,
				state: "running",
				lastEvent: null,
				lastSummary:
					"Attach-run dispatched; terminal callback owned by OpenCode-side plugin",
				updatedAt: "2000-01-01T00:00:00.000Z",
				attachRun: {
					pid: attachPid,
					started: true,
				},
				envelope: {
					task_id: "VAA-24-image-catalog",
					run_id: runId,
					agent_id: "fullstack",
					requested_agent_id: "fullstack",
					resolved_agent_id: "fullstack",
					session_key: "hook:opencode:fullstack:VAA-24-image-catalog",
					origin_session_key: "agent:fullstack:telegram:direct:5165741309",
					callback_target_session_key:
						"agent:fullstack:telegram:direct:5165741309",
					callback_target_session_id: "9606",
					project_id: "54a030dd-716a-4073-bdf9-4a5a203d9536",
					repo_root: "/Users/mrcagents/Work/projects/video2api",
					opencode_server_url: "http://127.0.0.1:56106",
				},
			},
			null,
			2,
		),
		"utf8",
	);

	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	const originalProcessKill = process.kill;
	process.env.OPENCLAW_STATE_DIR = stateDir;
	(process as any).kill = (pid: number, signal?: NodeJS.Signals | number) => {
		if (pid === attachPid && signal === "SIGTERM") return true;
		return originalProcessKill(pid, signal as any);
	};

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
		{ hookToken: "test-token" },
	);

	try {
		const route = routes.find(
			(x) => x.path === "/plugin/opencode-bridge/callback",
		);
		assert.ok(route, "callback route should be registered");

		const payload = {
			name: "OpenCode",
			agentId: "fullstack",
			sessionKey: "agent:fullstack:opencode:fullstack:callback:9606",
			sessionId: "9606",
			wakeMode: "now",
			deliver: false,
			message: JSON.stringify({
				kind: "opencode.callback",
				eventType: "message.updated",
				runId,
				taskId: "VAA-24-image-catalog",
				callbackTargetSessionKey:
					"agent:fullstack:opencode:fullstack:callback:9606",
				callbackTargetSessionId: "9606",
				callbackRelaySessionKey: "agent:fullstack:telegram:direct:5165741309",
				callbackRelaySessionId: "9606",
				opencodeSessionId: "ses_2e0841bd8ffePQNn705C9mL9j4",
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
		assert.equal(persisted.callbackOk, true);
		assert.equal(persisted.callbackStatus, 200);
		assert.match(
			String(persisted.callbackBody || ""),
			/"runId":"vaa24-image-catalog-20260324t2031"/,
		);
		assert.equal(persisted.attachRun?.cleaned, true);
		assert.equal(persisted.attachRun?.killSignal, "SIGTERM");
		assert.equal(persisted.attachRun?.killResult, "sigterm_sent");
	} finally {
		(process as any).kill = originalProcessKill;
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
