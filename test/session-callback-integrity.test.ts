import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredTool = {
  name: string;
  execute: (_id: string, params: any) => Promise<any>;
};

function parseToolJson(result: any) {
  const text = result?.content?.[0]?.text;
  assert.equal(typeof text, "string", "tool result must return content[0].text JSON string");
  return JSON.parse(text as string);
}

async function withMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

function setupHarness(configFile: any) {
  const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-int-test-"));
  const stateDir = join(tempRoot, "state");
  const bridgeDir = join(stateDir, "opencode-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "config.json"), JSON.stringify(configFile, null, 2), "utf8");

  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;

  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  };
  registerOpenCodeBridgeTools(api, {});

  return {
    stateDir,
    tools,
    cleanup() {
      if (prevStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

test("opencode_run_status resolves current caller session via callback_target_session_id", async () => {
  const mock = await withMockServer((req, res) => {
    const url = req.url || "/";
    if (url === "/global/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ healthy: true, version: "test" }));
      return;
    }
    if (url === "/session") {
      // Execution lane is newer, but artifact callback target session id must win.
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          { id: "sess-exec", time: { updated: 300 }, metadata: { run_id: "run-e2e-1", session_key: "hook:opencode:coder:task-e2e-1" } },
          { id: "sess-caller", time: { updated: 200 }, metadata: { session_key: "session:origin:e2e-1" } },
        ])
      );
      return;
    }
    if (url === "/session/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const harness = setupHarness({ opencodeServerUrl: mock.baseUrl, projectRegistry: [] });
  try {
    const runDir = join(harness.stateDir, "opencode-bridge", "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-e2e-1.json"),
      JSON.stringify(
        {
          taskId: "task-e2e-1",
          runId: "run-e2e-1",
          state: "running",
          updatedAt: new Date().toISOString(),
          envelope: {
            task_id: "task-e2e-1",
            run_id: "run-e2e-1",
            agent_id: "coder",
            requested_agent_id: "creator",
            resolved_agent_id: "coder",
            session_key: "hook:opencode:coder:task-e2e-1",
            origin_session_key: "session:origin:e2e-1",
            callback_target_session_key: "session:origin:e2e-1",
            callback_target_session_id: "sess-caller",
            project_id: "proj-e2e",
            repo_root: "/tmp/repo-e2e",
            opencode_server_url: mock.baseUrl,
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const tool = harness.tools.get("opencode_run_status");
    assert.ok(tool, "opencode_run_status should be registered");

    const result = await tool!.execute("test", { runId: "run-e2e-1", opencodeServerUrl: mock.baseUrl });
    const payload = parseToolJson(result);

    assert.equal(payload.ok, true);
    assert.equal(payload.sessionId, "sess-caller");
    assert.equal(payload.correlation?.sessionResolution?.strategy, "artifact");
    assert.equal(payload.current_state, "running");
    assert.ok(Array.isArray(payload.files_changed));
    assert.ok(Array.isArray(payload.verify_summary));
    assert.ok(Array.isArray(payload.blockers));
  } finally {
    await mock.close();
    harness.cleanup();
  }
});

test("opencode_run_status prefers callback target session key over execution session scoring", async () => {
  const mock = await withMockServer((req, res) => {
    const url = req.url || "/";
    if (url === "/global/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ healthy: true, version: "test" }));
      return;
    }
    if (url === "/session") {
      // Execution session includes run/task identifiers and is newer.
      // Caller session must still win by callback target session key.
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          { id: "sess-exec-2", time: { updated: 500 }, metadata: { run_id: "run-e2e-2", task_id: "task-e2e-2", session_key: "hook:opencode:coder:task-e2e-2" } },
          { id: "sess-caller-2", time: { updated: 250 }, metadata: { session_key: "session:origin:e2e-2" } },
        ])
      );
      return;
    }
    if (url === "/session/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const harness = setupHarness({ opencodeServerUrl: mock.baseUrl, projectRegistry: [] });
  try {
    const runDir = join(harness.stateDir, "opencode-bridge", "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-e2e-2.json"),
      JSON.stringify(
        {
          taskId: "task-e2e-2",
          runId: "run-e2e-2",
          state: "running",
          updatedAt: new Date().toISOString(),
          envelope: {
            task_id: "task-e2e-2",
            run_id: "run-e2e-2",
            agent_id: "coder",
            requested_agent_id: "creator",
            resolved_agent_id: "coder",
            session_key: "hook:opencode:coder:task-e2e-2",
            origin_session_key: "session:origin:e2e-2",
            callback_target_session_key: "session:origin:e2e-2",
            project_id: "proj-e2e",
            repo_root: "/tmp/repo-e2e",
            opencode_server_url: mock.baseUrl,
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const tool = harness.tools.get("opencode_run_status");
    assert.ok(tool, "opencode_run_status should be registered");

    const result = await tool!.execute("test", { runId: "run-e2e-2", opencodeServerUrl: mock.baseUrl });
    const payload = parseToolJson(result);

    assert.equal(payload.ok, true);
    assert.equal(payload.sessionId, "sess-caller-2");
    assert.equal(payload.correlation?.sessionResolution?.strategy, "scored_fallback");
    assert.ok(Array.isArray(payload.verify_summary));
    assert.ok(Array.isArray(payload.blockers));
  } finally {
    await mock.close();
    harness.cleanup();
  }
});

test("opencode_run_events resolves session by callback_target_session_id and keeps caller correlation", async () => {
  const mock = await withMockServer((req, res) => {
    const url = req.url || "/";
    if (url === "/session") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          { id: "sess-exec-evt", time: { updated: 900 }, metadata: { run_id: "run-e2e-evt-1", session_key: "hook:opencode:coder:task-e2e-evt-1" } },
          { id: "sess-caller-evt", time: { updated: 300 }, metadata: { session_key: "session:origin:e2e-evt-1" } },
        ])
      );
      return;
    }
    if (url === "/event") {
      res.setHeader("content-type", "text/event-stream");
      res.end([
        "event: message",
        "data: {\"type\":\"task.progress\",\"run_id\":\"run-e2e-evt-1\"}",
        "",
        "event: message",
        "data: {\"type\":\"task.completed\",\"run_id\":\"run-e2e-evt-1\"}",
        "",
      ].join("\n"));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const harness = setupHarness({ opencodeServerUrl: mock.baseUrl, projectRegistry: [] });
  try {
    const runDir = join(harness.stateDir, "opencode-bridge", "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-e2e-evt-1.json"),
      JSON.stringify(
        {
          taskId: "task-e2e-evt-1",
          runId: "run-e2e-evt-1",
          state: "running",
          updatedAt: new Date().toISOString(),
          envelope: {
            task_id: "task-e2e-evt-1",
            run_id: "run-e2e-evt-1",
            agent_id: "coder",
            requested_agent_id: "creator",
            resolved_agent_id: "coder",
            session_key: "hook:opencode:coder:task-e2e-evt-1",
            origin_session_key: "session:origin:e2e-evt-1",
            callback_target_session_key: "session:origin:e2e-evt-1",
            callback_target_session_id: "sess-caller-evt",
            project_id: "proj-e2e",
            repo_root: "/tmp/repo-e2e",
            opencode_server_url: mock.baseUrl,
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const tool = harness.tools.get("opencode_run_events");
    assert.ok(tool, "opencode_run_events should be registered");

    const result = await tool!.execute("test", {
      runId: "run-e2e-evt-1",
      scope: "session",
      limit: 2,
      timeoutMs: 1200,
      opencodeServerUrl: mock.baseUrl,
    });
    const payload = parseToolJson(result);

    assert.equal(payload.ok, true);
    assert.equal(payload.sessionId, "sess-caller-evt");
    assert.equal(payload.correlation?.sessionResolution?.strategy, "artifact");
    assert.equal(payload.eventCount, 2);
    assert.equal(payload.events?.[0]?.sessionId, "sess-caller-evt");
  } finally {
    await mock.close();
    harness.cleanup();
  }
});

test("opencode_session_tail prioritizes callback_target_session_key over execution-lane session", async () => {
  const requestedPaths: string[] = [];
  const mock = await withMockServer((req, res) => {
    const url = req.url || "/";
    requestedPaths.push(url);

    if (url === "/session") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          { id: "sess-exec-tail", time: { updated: 1200 }, metadata: { run_id: "run-e2e-tail-1", task_id: "task-e2e-tail-1", session_key: "hook:opencode:coder:task-e2e-tail-1" } },
          { id: "sess-caller-tail", time: { updated: 450 }, metadata: { session_key: "session:origin:e2e-tail-1" } },
        ])
      );
      return;
    }

    if (url === "/session/sess-caller-tail/message") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          { info: { id: "m1", role: "assistant", time: { created: 111 } }, parts: [{ type: "text", text: "caller-tail-message" }] },
        ])
      );
      return;
    }

    if (url === "/session/sess-caller-tail/diff") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ files: ["src/runtime.ts"] }));
      return;
    }

    if (url === "/session/sess-caller-tail") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "sess-caller-tail", title: "caller" }));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  const harness = setupHarness({ opencodeServerUrl: mock.baseUrl, projectRegistry: [] });
  try {
    const runDir = join(harness.stateDir, "opencode-bridge", "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-e2e-tail-1.json"),
      JSON.stringify(
        {
          taskId: "task-e2e-tail-1",
          runId: "run-e2e-tail-1",
          state: "running",
          updatedAt: new Date().toISOString(),
          envelope: {
            task_id: "task-e2e-tail-1",
            run_id: "run-e2e-tail-1",
            agent_id: "coder",
            requested_agent_id: "creator",
            resolved_agent_id: "coder",
            session_key: "hook:opencode:coder:task-e2e-tail-1",
            origin_session_key: "session:origin:e2e-tail-1",
            callback_target_session_key: "session:origin:e2e-tail-1",
            project_id: "proj-e2e",
            repo_root: "/tmp/repo-e2e",
            opencode_server_url: mock.baseUrl,
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const tool = harness.tools.get("opencode_session_tail");
    assert.ok(tool, "opencode_session_tail should be registered");

    const result = await tool!.execute("test", {
      runId: "run-e2e-tail-1",
      limit: 5,
      includeDiff: true,
      opencodeServerUrl: mock.baseUrl,
    });
    const payload = parseToolJson(result);

    assert.equal(payload.ok, true);
    assert.equal(payload.sessionId, "sess-caller-tail");
    assert.equal(payload.correlation?.sessionResolution?.strategy, "scored_fallback");
    assert.equal(payload.messages?.[0]?.text, "caller-tail-message");
    assert.ok(requestedPaths.includes("/session/sess-caller-tail/message"));
    assert.ok(!requestedPaths.includes("/session/sess-exec-tail/message"));
  } finally {
    await mock.close();
    harness.cleanup();
  }
});
