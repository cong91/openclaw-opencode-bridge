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
  const tempRoot = mkdtempSync(join(tmpdir(), "opb-run-status-wave3-"));
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

test("opencode_run_status includes callbackSummary and attachRunSummary", async () => {
  const mock = await withMockServer((req, res) => {
    const url = req.url || "/";
    if (url === "/global/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ healthy: true })); return; }
    if (url === "/session") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify([{ id: "sess-wave3-status", title: "runId=run-wave3-status repoRoot=/tmp/wave3-status", time: { updated: Date.now() } }])); return; }
    if (url === "/session/status") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true })); return; }
    if (url === "/event") { res.setHeader("content-type", "text/event-stream"); res.end(''); return; }
    res.statusCode = 404; res.end("not found");
  });
  const harness = setupHarness({ opencodeServerUrl: mock.baseUrl, projectRegistry: [] });
  try {
    const runDir = join(harness.stateDir, "opencode-bridge", "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run-wave3-status.json"), JSON.stringify({
      taskId: "task-wave3-status",
      runId: "run-wave3-status",
      state: "completed",
      realState: "completed",
      updatedAt: new Date().toISOString(),
      sessionId: "sess-wave3-status",
      callbackOk: true,
      callbackStatus: 200,
      callbackBody: '{"ok":true,"runId":"abc"}',
      attachRun: { pid: 123, started: true, cleaned: true, cleanedAt: new Date().toISOString(), killSignal: "SIGTERM", killResult: "sigterm_sent" },
      envelope: { task_id: "task-wave3-status", run_id: "run-wave3-status", agent_id: "build", requested_agent_id: "creator", resolved_agent_id: "build", session_key: "hook:opencode:build:task-wave3-status", origin_session_key: "session:origin:wave3-status", callback_target_session_key: "session:origin:wave3-status", project_id: "proj-wave3-status", repo_root: "/tmp/wave3-status", opencode_server_url: mock.baseUrl }
    }, null, 2), "utf8");
    const tool = harness.tools.get("opencode_run_status");
    assert.ok(tool);
    const payload = parseToolJson(await tool!.execute("test", { runId: "run-wave3-status", opencodeServerUrl: mock.baseUrl }));
    assert.equal(payload.callbackSummary.ok, true);
    assert.equal(payload.callbackSummary.status, 200);
    assert.equal(payload.attachRunSummary.pid, 123);
    assert.equal(payload.attachRunSummary.cleaned, true);
    assert.equal(payload.projectId, "proj-wave3-status");
    assert.equal(payload.sessionId, "sess-wave3-status");
  } finally {
    await mock.close();
    harness.cleanup();
  }
});
