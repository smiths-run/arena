/**
 * The operator-control rows, exercised against a throwaway database. The env
 * override must be set before store.ts is imported — its module load opens the
 * ledger — which is why the import is dynamic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTS_DATA_DIR = mkdtempSync(join(tmpdir(), "agents-store-test-"));
const store = await import("./store.ts");

test("pause is off by default, sticks when set, and clears when unset", () => {
  assert.equal(store.isPaused("anvil"), false);
  store.setPaused("anvil", true);
  assert.equal(store.isPaused("anvil"), true);
  store.setPaused("anvil", false);
  assert.equal(store.isPaused("anvil"), false);
});

test("a run request is consumed exactly once", () => {
  assert.equal(store.takeRunRequest("tongs"), false, "no request yet");
  store.requestRun("tongs");
  assert.equal(store.hasPendingRunRequest("tongs"), true);
  assert.equal(store.takeRunRequest("tongs"), true, "first take consumes it");
  assert.equal(store.takeRunRequest("tongs"), false, "second take finds nothing");
});

test("two clicks are two requests are two runs", () => {
  store.requestRun("bellows");
  store.requestRun("bellows");
  assert.equal(store.takeRunRequest("bellows"), true);
  assert.equal(store.takeRunRequest("bellows"), true);
  assert.equal(store.takeRunRequest("bellows"), false);
});

test("requests are scoped to their agent", () => {
  store.requestRun("anvil");
  assert.equal(store.takeRunRequest("bellows"), false);
  assert.equal(store.takeRunRequest("anvil"), true);
});

test("heartbeat records and reads back", () => {
  assert.equal(store.lastHeartbeatAt(), 0, "no heartbeat yet");
  const before = Date.now();
  store.heartbeat();
  assert.ok(store.lastHeartbeatAt() >= before);
});
