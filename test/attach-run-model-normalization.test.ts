import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runAttachExecutionForEnvelope, buildEnvelope } from "../src/runtime";

test("runAttachExecutionForEnvelope normalizes bare model ids to proxy/<model>", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "opb-attach-model-"));
  const repoRoot = join(tempRoot, "repo");
  mkdirSync(repoRoot, { recursive: true });

  const originalPath = process.env.PATH || "";
  const shimDir = join(tempRoot, "bin");
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, "opencode");
  const script = `#!/bin/sh\nexit 0\n`;
  await import("node:fs/promises").then(fs => fs.writeFile(shimPath, script, { mode: 0o755 }));
  process.env.PATH = `${shimDir}:${originalPath}`;

  try {
    const envelope = buildEnvelope({
      taskId: "task-attach-model-1",
      runId: "run-attach-model-1",
      requestedAgentId: "scrum",
      resolvedAgentId: "fullstack",
      originSessionKey: "agent:scrum:telegram:direct:5165741309",
      originSessionId: "81cdf00e-a4cd-424c-ad9c-25a19d126a7c",
      projectId: "taa",
      repoRoot,
      serverUrl: "http://127.0.0.1:4999",
      priority: "high",
      deliver: false,
    });

    const result = await runAttachExecutionForEnvelope({
      cfg: {},
      envelope,
      prompt: "test prompt",
      model: "gpt-5.3-codex",
      promptVariant: "high",
    });

    assert.equal(result.command, "opencode");
    assert.ok(result.args.includes("--model"));
    assert.ok(result.args.includes("proxy/gpt-5.3-codex"));
    assert.equal(result.args.includes("gpt-5.3-codex"), false);
  } finally {
    process.env.PATH = originalPath;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
