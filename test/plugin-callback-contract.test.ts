import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import OpenClawBridgeCallbackPlugin from "../opencode-plugin/openclaw-bridge-callback";

function readAudit(path: string) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("OpenCode-side plugin emits terminal callbacks per terminal event type for same run", async () => {
	const root = mkdtempSync(join(tmpdir(), "opencode-plugin-test-"));
	const auditDir = join(root, ".opencode");
	mkdirSync(auditDir, { recursive: true });
	const auditPath = join(auditDir, "bridge-callback-audit.jsonl");

	const oldHookBase = process.env.OPENCLAW_HOOK_BASE_URL;
	const oldHookToken = process.env.OPENCLAW_HOOK_TOKEN;
	const oldAuditDir = process.env.OPENCLAW_BRIDGE_AUDIT_DIR;
	const oldFetch = globalThis.fetch;
	const callbackHits: any[] = [];

	process.env.OPENCLAW_HOOK_BASE_URL = "http://callback.test";
	process.env.OPENCLAW_HOOK_TOKEN = "token-test";
	process.env.OPENCLAW_BRIDGE_AUDIT_DIR = auditDir;
	globalThis.fetch = async (_input: any, init?: any) => {
		callbackHits.push(JSON.parse(String(init?.body || "{}")));
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true }),
		} as any;
	};

	try {
		const clientLogs: any[] = [];
		const plugin = await OpenClawBridgeCallbackPlugin({
			client: { app: { log: async (entry: any) => clientLogs.push(entry) } },
			directory: root,
		} as any);

		assert.equal(typeof plugin.event, "function");

		await plugin.event({
			event: {
				type: "session.created",
				properties: {
					info: {
						id: "sess-1",
						title:
							"demo runId=run-1 taskId=task-1 requested=fullstack resolved=fullstack callbackSession=agent:fullstack:opencode:fullstack:callback:session-123 callbackSessionId=session-123 callbackRelaySession=agent:fullstack:telegram:direct:5165741309 callbackRelaySessionId=session-123",
					},
				},
			},
		});

		await plugin.event({
			event: {
				type: "message.updated",
				properties: {
					info: {
						sessionID: "sess-1",
						finish: "stop",
					},
				},
			},
		});

		await plugin.event({
			event: {
				type: "session.idle",
				properties: {
					sessionID: "sess-1",
				},
			},
		});

		const rows = readAudit(auditPath);
		assert.equal(callbackHits.length, 2);
		assert.equal(callbackHits[0].agentId, "fullstack");
		assert.equal(
			callbackHits[0].sessionKey,
			"agent:fullstack:opencode:fullstack:callback:session-123",
		);
		assert.equal(callbackHits[0].sessionId, "session-123");
		const callbackMetadata = JSON.parse(callbackHits[0].message);
		assert.equal(callbackMetadata.kind, "opencode.callback");
		assert.equal(callbackMetadata.eventType, "message.updated");
		assert.equal(callbackHits[1].eventType, "session.idle");
		const callbackMetadata2 = JSON.parse(callbackHits[1].message);
		assert.equal(callbackMetadata2.kind, "opencode.callback");
		assert.equal(callbackMetadata2.eventType, "session.idle");
		assert.equal(callbackMetadata.runId, "run-1");
		assert.equal(callbackMetadata.taskId, "task-1");
		assert.equal(callbackMetadata.requestedAgentId, "fullstack");
		assert.equal(callbackMetadata.resolvedAgentId, "fullstack");
		assert.equal(
			callbackMetadata.callbackTargetSessionKey,
			"agent:fullstack:opencode:fullstack:callback:session-123",
		);
		assert.equal(callbackMetadata.callbackTargetSessionId, "session-123");
		assert.ok(
			rows.some(
				(r) => r.phase === "event_seen" && r.event_type === "session.created",
			),
		);
		assert.ok(rows.some((r) => r.ok === true && r.status === 200));
		assert.equal(
			rows.some((r) => r.phase === "deduped"),
			false,
		);
		assert.equal(clientLogs.length > 0, true);
	} finally {
		globalThis.fetch = oldFetch;
		if (oldHookBase === undefined) delete process.env.OPENCLAW_HOOK_BASE_URL;
		else process.env.OPENCLAW_HOOK_BASE_URL = oldHookBase;
		if (oldHookToken === undefined) delete process.env.OPENCLAW_HOOK_TOKEN;
		else process.env.OPENCLAW_HOOK_TOKEN = oldHookToken;
		if (oldAuditDir === undefined) delete process.env.OPENCLAW_BRIDGE_AUDIT_DIR;
		else process.env.OPENCLAW_BRIDGE_AUDIT_DIR = oldAuditDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("OpenCode-side plugin keeps dedupe for duplicate terminal callbacks of same event type", async () => {
	const root = mkdtempSync(join(tmpdir(), "opencode-plugin-dedupe-"));
	const auditDir = join(root, ".opencode");
	mkdirSync(auditDir, { recursive: true });
	const auditPath = join(auditDir, "bridge-callback-audit.jsonl");

	const oldHookBase = process.env.OPENCLAW_HOOK_BASE_URL;
	const oldHookToken = process.env.OPENCLAW_HOOK_TOKEN;
	const oldAuditDir = process.env.OPENCLAW_BRIDGE_AUDIT_DIR;
	const oldFetch = globalThis.fetch;
	const callbackHits: any[] = [];

	process.env.OPENCLAW_HOOK_BASE_URL = "http://callback.test";
	process.env.OPENCLAW_HOOK_TOKEN = "token-test";
	process.env.OPENCLAW_BRIDGE_AUDIT_DIR = auditDir;
	globalThis.fetch = async (_input: any, init?: any) => {
		callbackHits.push(JSON.parse(String(init?.body || "{}")));
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true }),
		} as any;
	};

	try {
		const plugin = await OpenClawBridgeCallbackPlugin({
			client: { app: { log: async () => {} } },
			directory: root,
		} as any);

		await plugin.event({
			event: {
				type: "session.created",
				properties: {
					info: {
						id: "sess-dup-1",
						title:
							"demo runId=run-dup-1 taskId=task-dup-1 requested=fullstack resolved=fullstack callbackSession=agent:fullstack:opencode:fullstack:callback:session-dup-1 callbackSessionId=session-dup-1",
					},
				},
			},
		});

		await plugin.event({
			event: {
				type: "session.idle",
				properties: {
					sessionID: "sess-dup-1",
				},
			},
		});

		await plugin.event({
			event: {
				type: "session.idle",
				properties: {
					sessionID: "sess-dup-1",
				},
			},
		});

		const rows = readAudit(auditPath);
		assert.equal(callbackHits.length, 1);
		assert.ok(
			rows.some(
				(r) =>
					r.phase === "deduped" &&
					r.event_type === "session.idle" &&
					typeof r.dedupeKey === "string" &&
					r.dedupeKey.endsWith("|session.idle"),
			),
		);
	} finally {
		globalThis.fetch = oldFetch;
		if (oldHookBase === undefined) delete process.env.OPENCLAW_HOOK_BASE_URL;
		else process.env.OPENCLAW_HOOK_BASE_URL = oldHookBase;
		if (oldHookToken === undefined) delete process.env.OPENCLAW_HOOK_TOKEN;
		else process.env.OPENCLAW_HOOK_TOKEN = oldHookToken;
		if (oldAuditDir === undefined) delete process.env.OPENCLAW_BRIDGE_AUDIT_DIR;
		else process.env.OPENCLAW_BRIDGE_AUDIT_DIR = oldAuditDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("OpenCode-side plugin emits periodic checkpoint updates only on runtime progress events with throttle", async () => {
	const root = mkdtempSync(join(tmpdir(), "opencode-plugin-periodic-"));
	const auditDir = join(root, ".opencode");
	mkdirSync(auditDir, { recursive: true });

	const oldHookBase = process.env.OPENCLAW_HOOK_BASE_URL;
	const oldHookToken = process.env.OPENCLAW_HOOK_TOKEN;
	const oldAuditDir = process.env.OPENCLAW_BRIDGE_AUDIT_DIR;
	const oldFetch = globalThis.fetch;
	const oldNow = Date.now;
	const callbackHits: any[] = [];
	let now = 1_000;

	process.env.OPENCLAW_HOOK_BASE_URL = "http://callback.test";
	process.env.OPENCLAW_HOOK_TOKEN = "token-test";
	process.env.OPENCLAW_BRIDGE_AUDIT_DIR = auditDir;
	Date.now = () => now;
	globalThis.fetch = async (_input: any, init?: any) => {
		callbackHits.push(JSON.parse(String(init?.body || "{}")));
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true }),
		} as any;
	};

	try {
		const plugin = await OpenClawBridgeCallbackPlugin({
			client: { app: { log: async () => {} } },
			directory: root,
		} as any);

		await plugin.event({
			event: {
				type: "session.created",
				properties: {
					info: {
						id: "sess-periodic-1",
						title:
							"demo runId=run-p1 taskId=task-p1 requested=creator resolved=builder callbackSession=agent:creator:opencode:creator:callback:session-p1 callbackSessionId=session-p1 callbackRelaySession=agent:creator:telegram:direct:5165741309 callbackRelaySessionId=session-p1",
					},
				},
			},
		});

		await plugin.event({
			event: {
				type: "task.progress",
				properties: { sessionID: "sess-periodic-1" },
			},
		});
		assert.equal(callbackHits.length, 1);
		assert.equal(callbackHits[0].eventType, "task.progress");
		assert.equal(callbackHits[0].next.action, "none");

		now += 30_000;
		await plugin.event({
			event: {
				type: "task.progress",
				properties: { sessionID: "sess-periodic-1" },
			},
		});
		assert.equal(
			callbackHits.length,
			1,
			"throttle blocks frequent periodic updates",
		);

		now += 130_000;
		await plugin.event({
			event: {
				type: "task.progress",
				properties: { sessionID: "sess-periodic-1" },
			},
		});
		assert.equal(callbackHits.length, 2);
		assert.equal(callbackHits[1].next.action, "none");

		await plugin.event({
			event: {
				type: "session.idle",
				properties: { sessionID: "sess-periodic-1" },
			},
		});
		assert.equal(callbackHits.length, 3);
		assert.equal(callbackHits[2].eventType, "session.idle");
		assert.equal(callbackHits[2].next.action, "launch_run");
	} finally {
		Date.now = oldNow;
		globalThis.fetch = oldFetch;
		if (oldHookBase === undefined) delete process.env.OPENCLAW_HOOK_BASE_URL;
		else process.env.OPENCLAW_HOOK_BASE_URL = oldHookBase;
		if (oldHookToken === undefined) delete process.env.OPENCLAW_HOOK_TOKEN;
		else process.env.OPENCLAW_HOOK_TOKEN = oldHookToken;
		if (oldAuditDir === undefined) delete process.env.OPENCLAW_BRIDGE_AUDIT_DIR;
		else process.env.OPENCLAW_BRIDGE_AUDIT_DIR = oldAuditDir;
		rmSync(root, { recursive: true, force: true });
	}
});
