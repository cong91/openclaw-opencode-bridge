import assert from "node:assert/strict";
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

import {
	claimNextCallbackPendingItem,
	getCallbackPendingFilePath,
	markCallbackPendingItemDone,
	resolveCallbackIngressTarget,
	upsertCallbackPendingItem,
} from "../src/heartbeat-dispatcher";

test("resolveCallbackIngressTarget resolves workspace dynamically from session registry", () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-hb-resolve-"));
	const stateDir = join(tempRoot, "state");
	const workspaceDir = join(tempRoot, "workspace-builder");
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(join(stateDir, "opencode-bridge"), { recursive: true });
	writeFileSync(
		join(stateDir, "opencode-bridge", "sessions.json"),
		JSON.stringify(
			{
				entries: [
					{
						session_id: "sess-hb-1",
						serve_id: "serve-1",
						opencode_server_url: "http://127.0.0.1:4096",
						directory: workspaceDir,
						updated_at: new Date().toISOString(),
					},
				],
			},
			null,
			2,
		),
		"utf8",
	);

	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;
	try {
		const resolved = resolveCallbackIngressTarget({
			cfg: {},
			callback: {
				sessionKey: "agent:builder:telegram:direct:123",
				sessionId: "sess-hb-1",
			},
			metadata: {
				kind: "opencode.callback",
				eventType: "task.completed",
				runId: "run-hb-1",
				taskId: "task-hb-1",
				callbackTargetSessionId: "sess-hb-1",
			},
		});

		assert.equal(resolved.workspaceSource, "session_registry");
		assert.equal(resolved.workspaceDir, workspaceDir);
		assert.equal(resolved.sessionId, "sess-hb-1");
		assert.equal(resolved.agentId, "builder");
	} finally {
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("getCallbackPendingFilePath validates session id and keeps path inside workspace", () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-hb-path-"));
	try {
		const { pendingDir, filePath } = getCallbackPendingFilePath({
			workspaceDir: tempRoot,
			sessionId: "sess_safe-01",
		});
		assert.equal(pendingDir, join(tempRoot, ".callback-pending"));
		assert.equal(
			filePath,
			join(tempRoot, ".callback-pending", "sess_safe-01.json"),
		);
		assert.throws(
			() =>
				getCallbackPendingFilePath({
					workspaceDir: tempRoot,
					sessionId: "../escape",
				}),
			/Invalid sessionId/i,
		);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("callback pending lifecycle supports pending -> claimed -> done with dedupe", () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "opencode-bridge-hb-life-"));
	try {
		const first = upsertCallbackPendingItem({
			workspaceDir,
			agentId: "builder",
			sessionKey: "agent:builder:telegram:direct:123",
			sessionId: "sess-life-1",
			dedupeKey: "opencode:run-life-1:task.completed",
			runId: "run-life-1",
			eventType: "task.completed",
			rawMessage: "callback-1",
		});
		assert.equal(first.deduped, false);
		assert.equal(first.state.items.length, 1);
		assert.equal(first.state.items[0]?.status, "pending");

		const second = upsertCallbackPendingItem({
			workspaceDir,
			agentId: "builder",
			sessionKey: "agent:builder:telegram:direct:123",
			sessionId: "sess-life-1",
			dedupeKey: "opencode:run-life-1:task.completed",
			rawMessage: "callback-2",
		});
		assert.equal(second.deduped, true);
		assert.equal(second.state.items.length, 1);
		assert.equal(second.state.items[0]?.rawMessage, "callback-2");

		const claimed = claimNextCallbackPendingItem({
			workspaceDir,
			sessionId: "sess-life-1",
			claimer: "builder",
		});
		assert.equal(claimed.claimed?.status, "claimed");
		assert.equal(typeof claimed.claimed?.claimedAt, "string");

		const done = markCallbackPendingItemDone({
			workspaceDir,
			sessionId: "sess-life-1",
			itemId: "opencode:run-life-1:task.completed",
		});
		assert.equal(done.done?.status, "done");
		assert.equal(typeof done.done?.doneAt, "string");

		const persisted = JSON.parse(
			readFileSync(
				join(workspaceDir, ".callback-pending", "sess-life-1.json"),
				"utf8",
			),
		) as { items: Array<{ status: string; id: string }> };
		assert.equal(persisted.items.length, 1);
		assert.equal(persisted.items[0]?.id, "opencode:run-life-1:task.completed");
		assert.equal(persisted.items[0]?.status, "done");
	} finally {
		rmSync(workspaceDir, { recursive: true, force: true });
	}
});
