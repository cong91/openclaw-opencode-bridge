import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { fetchServeProjectBinding } from "../src/runtime";

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

test("fetchServeProjectBinding resolves current directory from project/current", async () => {
  const mock = await withMockServer((req, res) => {
    if (req.url === "/project/current") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ directory: "/tmp/project-a" }));
      return;
    }
    if (req.url === "/path") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ cwd: "/tmp/project-a" }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  try {
    const binding = await fetchServeProjectBinding(mock.baseUrl);
    assert.equal(binding.ok, true);
    assert.equal(binding.directory, "/tmp/project-a");
  } finally {
    await mock.close();
  }
});

test("fetchServeProjectBinding falls back to /path when project/current lacks directory", async () => {
  const mock = await withMockServer((req, res) => {
    if (req.url === "/project/current") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ projectId: "abc" }));
      return;
    }
    if (req.url === "/path") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ cwd: "/tmp/project-b" }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  try {
    const binding = await fetchServeProjectBinding(mock.baseUrl);
    assert.equal(binding.ok, true);
    assert.equal(binding.directory, "/tmp/project-b");
  } finally {
    await mock.close();
  }
});
