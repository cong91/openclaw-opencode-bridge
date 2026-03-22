import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import OpenClawBridgeCallbackPlugin from "../opencode-plugin/openclaw-bridge-callback";

function readLines(path: string) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("OpenCode-side plugin mirrors callback outcome into OpenClaw-side audit file", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-plugin-audit-test-"));
  const auditDir = join(root, ".opencode");
  const openclawAuditDir = join(root, ".openclaw", "opencode-bridge", "audit");
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(openclawAuditDir, { recursive: true });
  const openclawAuditPath = join(openclawAuditDir, "callbacks.jsonl");

  const oldHookBase = process.env.OPENCLAW_HOOK_BASE_URL;
  const oldHookToken = process.env.OPENCLAW_HOOK_TOKEN;
  const oldAuditDir = process.env.OPENCLAW_BRIDGE_AUDIT_DIR;
  const oldOpenclawAudit = process.env.OPENCLAW_BRIDGE_OPENCLAW_AUDIT_PATH;
  const oldFetch = globalThis.fetch;

  process.env.OPENCLAW_HOOK_BASE_URL = "http://callback.test";
  process.env.OPENCLAW_HOOK_TOKEN = "token-test";
  process.env.OPENCLAW_BRIDGE_AUDIT_DIR = auditDir;
  process.env.OPENCLAW_BRIDGE_OPENCLAW_AUDIT_PATH = openclawAuditPath;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, runId: "hook-run-1" }) } as any);

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
            id: "sess-audit",
            title: "demo runId=run-audit taskId=task-audit requested=fullstack resolved=fullstack callbackSession=agent:fullstack:telegram:direct:5165741309 callbackSessionId=session-audit",
          },
        },
      },
    });

    await plugin.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "sess-audit" },
      },
    });

    const rows = readLines(openclawAuditPath);
    const callbackRows = rows.filter((row) => row.callbackOk === true || row.callbackStatus !== undefined);
    assert.equal(callbackRows.length >= 1, true);
    const target = callbackRows.find((row) => row.runId === "run-audit") || callbackRows[0];
    assert.equal(target.callbackOk, true);
    assert.equal(target.callbackStatus, 200);
    assert.equal(target.runId, "run-audit");
    assert.equal(target.taskId, "task-audit");
    assert.equal(target.requestedAgentId, "fullstack");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldHookBase === undefined) delete process.env.OPENCLAW_HOOK_BASE_URL; else process.env.OPENCLAW_HOOK_BASE_URL = oldHookBase;
    if (oldHookToken === undefined) delete process.env.OPENCLAW_HOOK_TOKEN; else process.env.OPENCLAW_HOOK_TOKEN = oldHookToken;
    if (oldAuditDir === undefined) delete process.env.OPENCLAW_BRIDGE_AUDIT_DIR; else process.env.OPENCLAW_BRIDGE_AUDIT_DIR = oldAuditDir;
    if (oldOpenclawAudit === undefined) delete process.env.OPENCLAW_BRIDGE_OPENCLAW_AUDIT_PATH; else process.env.OPENCLAW_BRIDGE_OPENCLAW_AUDIT_PATH = oldOpenclawAudit;
    rmSync(root, { recursive: true, force: true });
  }
});
