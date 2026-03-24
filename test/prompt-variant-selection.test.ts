import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { startExecutionRun, buildEnvelope } from "../src/runtime";

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

test.skip("startExecutionRun sends reasoningEffort=high for high-priority complex tasks", async () => {
  let seenReasoningEffort: string | null = null;
  const tempRoot = mkdtempSync(join(tmpdir(), "opb-prompt-variant-"));
  const repoRoot = join(tempRoot, "repo");
  mkdirSync(repoRoot, { recursive: true });

  const mock = await withMockServer((req, res) => {
    const url = req.url || "/";
    if (req.method === "POST" && url === "/session") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "sess-variant-1", title: JSON.parse(body).title }));
      });
      return;
    }
    if (req.method === "POST" && url === "/session/sess-variant-1/prompt_async") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        seenReasoningEffort = parsed.reasoningEffort;
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    if (req.method === "GET" && url === "/session") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: "sess-variant-1", title: "complex session" }]));
      return;
    }
    if (req.method === "GET" && url === "/session/sess-variant-1") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "sess-variant-1", title: "complex session" }));
      return;
    }
    if (req.method === "GET" && url === "/session/sess-variant-1/message") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ info: { id: "msg_run-variant-1" } }]));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  try {
    const envelope = buildEnvelope({
      taskId: "task-variant-1",
      runId: "run-variant-1",
      requestedAgentId: "assistant",
      resolvedAgentId: "fullstack",
      originSessionKey: "agent:assistant:telegram:5165741309",
      originSessionId: "9579",
      projectId: "proj-variant-1",
      repoRoot,
      serverUrl: mock.baseUrl,
      priority: "high",
      deliver: false,
    });

    const result = await startExecutionRun({
      cfg: {},
      envelope,
      prompt: "Implement a multi-step migration with strict compatibility requirements and several acceptance criteria.",
      model: "proxy/gpt-5.4",
      continuation: {
        promptVariant: "high",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(seenReasoningEffort, "high");
  } finally {
    await mock.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
