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

test("a market is named by its ticker, and by its id until one is known", () => {
  assert.equal(store.marketSymbol("11"), null, "nothing learned yet");
  assert.equal(store.marketLabel("11"), "market 11", "id carries the label meanwhile");

  store.rememberMarkets([{ id: 11n, symbol: "PULSE", name: "Pulse" }]);
  assert.equal(store.marketSymbol("11"), "PULSE");
  assert.equal(store.marketLabel(11n), "PULSE");
  assert.equal(store.marketSymbols().get("11"), "PULSE");
});

test("a blank read never overwrites a name we already have", () => {
  store.rememberMarkets([{ id: 12n, symbol: "EMBER", name: "Ember" }]);
  store.rememberMarkets([{ id: 12n, symbol: "", name: "" }]);
  assert.equal(store.marketSymbol(12n), "EMBER", "a rate-limited read is not a rename");
});
