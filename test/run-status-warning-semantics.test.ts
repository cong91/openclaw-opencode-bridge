import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredTool = { name: string; execute: (_id: string, params: any) => Promise<any> };
function parseToolJson(result: any) { return JSON.parse(result.content[0].text); }
async function withMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, close: async () => await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}
function setupHarness(configFile: any) {
  const tempRoot = mkdtempSync(join(tmpdir(), "opb-warning-semantics-"));
  const stateDir = join(tempRoot, "state");
  const bridgeDir = join(stateDir, "opencode-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "config.json"), JSON.stringify(configFile, null, 2), "utf8");
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const tools = new Map<string, RegisteredTool>();
  registerOpenCodeBridgeTools({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } }, {});
  return { stateDir, tools, cleanup() { if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = prevStateDir; rmSync(tempRoot, { recursive: true, force: true }); } };
}

test("opencode_run_status emits warning semantics for unreconciled running artifacts", async () => {
  const mock = await withMockServer((req, res) => {
    const url = req.url || "/";
    if (url === "/global/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ healthy: true })); return; }
    if (url === "/session") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify([])); return; }
    if (url === "/session/status") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true })); return; }
    res.statusCode = 404; res.end("not found");
  });
  const harness = setupHarness({ opencodeServerUrl: mock.baseUrl, projectRegistry: [] });
  try {
    const runDir = join(harness.stateDir, "opencode-bridge", "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run-warn-1.json"), JSON.stringify({
      taskId: "task-warn-1",
      runId: "run-warn-1",
      state: "running",
      updatedAt: new Date().toISOString(),
      callbackOk: true,
      callbackCleaned: true,
      sessionResolutionPending: true,
      attachRun: { pid: 12345, cleaned: true, killSignal: "SIGTERM", killResult: "sigterm_sent" },
      envelope: { task_id: "task-warn-1", run_id: "run-warn-1", agent_id: "build", requested_agent_id: "creator", resolved_agent_id: "build", session_key: "hook:opencode:build:task-warn-1", origin_session_key: "session:origin:warn", callback_target_session_key: "session:origin:warn", project_id: "proj-warn", repo_root: "/tmp/warn", opencode_server_url: mock.baseUrl }
    }, null, 2), "utf8");
    const tool = harness.tools.get("opencode_run_status");
    assert.ok(tool);
    const payload = parseToolJson(await tool!.execute("test", { runId: "run-warn-1", opencodeServerUrl: mock.baseUrl }));
    assert.ok(payload.warnings.includes("session_resolution_pending"));
    assert.ok(payload.warnings.includes("no_session_materialized"));
    assert.ok(payload.warnings.includes("callback_sent_but_not_reconciled"));
    assert.ok(payload.warnings.includes("attach_run_cleaned_but_artifact_not_terminal"));
  } finally {
    await mock.close();
    harness.cleanup();
  }
});
