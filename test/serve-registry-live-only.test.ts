import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	getServeRegistryPath,
	getSessionRegistryPath,
	upsertServeRegistry,
	upsertSessionRegistry,
} from "../src/runtime";

test("upsertServeRegistry preserves serve lifecycle entries across different serves", () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "opb-serve-live-only-"));
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	mkdirSync(bridgeDir, { recursive: true });

	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		upsertServeRegistry({
			serve_id: "http://127.0.0.1:60001",
			opencode_server_url: "http://127.0.0.1:60001",
			pid: 60001,
			status: "running",
			updated_at: new Date().toISOString(),
		} as any);
		upsertServeRegistry({
			serve_id: "http://127.0.0.1:60002",
			opencode_server_url: "http://127.0.0.1:60002",
			pid: 60002,
			status: "running",
			updated_at: new Date().toISOString(),
		} as any);

		const persisted = JSON.parse(readFileSync(getServeRegistryPath(), "utf8"));
		assert.equal(Array.isArray(persisted.entries), true);
		assert.equal(persisted.entries.length, 2);
		const urls = persisted.entries
			.map((entry: any) => entry.opencode_server_url)
			.sort();
		assert.deepEqual(urls, [
			"http://127.0.0.1:60001",
			"http://127.0.0.1:60002",
		]);
	} finally {
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("upsertServeRegistry retains stopped lifecycle state", () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "opb-serve-lifecycle-state-"));
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	mkdirSync(bridgeDir, { recursive: true });

	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const updatedAt = new Date().toISOString();
		upsertServeRegistry({
			serve_id: "http://127.0.0.1:62001",
			opencode_server_url: "http://127.0.0.1:62001",
			pid: 62001,
			status: "running",
			updated_at: updatedAt,
		} as any);

		upsertServeRegistry({
			serve_id: "http://127.0.0.1:62001",
			opencode_server_url: "http://127.0.0.1:62001",
			pid: 62001,
			status: "stopped",
			updated_at: new Date(Date.now() + 1000).toISOString(),
		} as any);

		const persisted = JSON.parse(readFileSync(getServeRegistryPath(), "utf8"));
		assert.equal(Array.isArray(persisted.entries), true);
		assert.equal(persisted.entries.length, 1);
		assert.equal(
			persisted.entries[0].opencode_server_url,
			"http://127.0.0.1:62001",
		);
		assert.equal(persisted.entries[0].status, "stopped");
	} finally {
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("upsertSessionRegistry maintains one current session per directory", () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "opb-session-current-only-"));
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	mkdirSync(bridgeDir, { recursive: true });

	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const now = new Date().toISOString();
		upsertSessionRegistry({
			session_id: "sess-1",
			serve_id: "http://127.0.0.1:4096",
			opencode_server_url: "http://127.0.0.1:4096",
			directory: "/tmp/repo-shared",
			is_current_for_directory: true,
			updated_at: now,
		} as any);

		upsertSessionRegistry({
			session_id: "sess-2",
			serve_id: "http://127.0.0.1:6123",
			opencode_server_url: "http://127.0.0.1:6123",
			directory: "/tmp/repo-shared",
			is_current_for_directory: true,
			updated_at: new Date(Date.now() + 1000).toISOString(),
		} as any);

		const persisted = JSON.parse(
			readFileSync(getSessionRegistryPath(), "utf8"),
		);
		assert.equal(Array.isArray(persisted.entries), true);
		assert.equal(persisted.entries.length, 2);
		const first = persisted.entries.find((x: any) => x.session_id === "sess-1");
		const second = persisted.entries.find(
			(x: any) => x.session_id === "sess-2",
		);
		assert.equal(first?.is_current_for_directory, false);
		assert.equal(second?.is_current_for_directory, true);
	} finally {
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
