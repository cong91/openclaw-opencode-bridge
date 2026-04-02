import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");
const installScript = join(repoRoot, "scripts", "install-bridge.mjs");

test("install-bridge rejects entry-file target path to prevent accidental plugin id 'index'", () => {
	const badTarget = join(repoRoot, "dist", "src", "index.js");

	const result = spawnSync(
		"node",
		[
			installScript,
			"--mode",
			"project",
			"--target",
			badTarget,
			"--skip-openclaw",
			"--skip-opencode",
		],
		{
			cwd: repoRoot,
			encoding: "utf8",
		},
	);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /Forbidden install target/i);
	assert.match(result.stderr, /index\.js/i);
	assert.match(result.stderr, /openclaw plugins install -l <repo-root>/i);
});
