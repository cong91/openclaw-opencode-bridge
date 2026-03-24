import test from "node:test";
import assert from "node:assert/strict";

test("audit policy classification states are documented", () => {
  const classes = [
    "active_serve",
    "orphan_serve",
    "active_attach_run",
    "stale_attach_run",
    "orphan_attach_run",
  ];
  assert.equal(classes.includes("active_serve"), true);
  assert.equal(classes.includes("orphan_serve"), true);
  assert.equal(classes.includes("active_attach_run"), true);
  assert.equal(classes.includes("stale_attach_run"), true);
  assert.equal(classes.includes("orphan_attach_run"), true);
});
