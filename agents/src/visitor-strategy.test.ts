/**
 * The operator boundary: whatever an operator types, the resulting agent must
 * sit inside the same regime the house agents live under — with its handle
 * normalized, its Approach shaping taste (never limits), its Mandate bounded
 * prose, and the LLM on by default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROACHES,
  APPROACH_WEIGHTS,
  planVisitorAgent,
  serializeStrategy,
  deserializeStrategy,
} from "./visitor-strategy.ts";

test("a plain handle yields a bounded strategy and its own launch token", () => {
  const p = planVisitorAgent({ handle: "@Forge" });
  assert.equal(p.handle, "forge", "handle is normalized: lowercase, no @");
  assert.equal(p.symbol, "FORGE");
  assert.deepEqual(p.strategy.launchNames, [{ name: "forge", symbol: "FORGE" }]);
  assert.equal(p.strategy.maxOwnMarkets, 1);
  assert.ok(p.strategy.maxTradeUsdc <= 2_000_000n, "never above the house trader's cap");
  assert.equal(p.strategy.operatingReserveUsdc, 500_000n);
});

test("the LLM is on by default — an empty Mandate does not demote the agent", () => {
  const p = planVisitorAgent({ handle: "quiet" });
  assert.equal(p.mandate, null);
  assert.equal(p.strategy.llm.enabled, true);
  assert.equal(p.strategy.llm.maxCallsPerDay, 30, "thinking is capped like any other cost");
});

test("risk renames map to the spec numbers, legacy names still accepted", () => {
  const low = planVisitorAgent({ handle: "low-one", risk: "low" });
  assert.equal(low.strategy.maxTradeUsdc, 500_000n);
  assert.equal(low.strategy.minExternalTrades, 2);

  const high = planVisitorAgent({ handle: "high-one", risk: "high" });
  assert.equal(high.strategy.maxTradeUsdc, 2_000_000n);
  assert.equal(high.strategy.stopLossBps, 2_500n);

  const legacy = planVisitorAgent({ handle: "old-one", risk: "bold" });
  assert.equal(legacy.strategy.maxTradeUsdc, 2_000_000n, "bold still means high");
  assert.equal(planVisitorAgent({ handle: "odd", risk: "yolo" }).strategy.maxTradeUsdc, 1_000_000n);
});

test("approach is a taste, not a permission: strategy limits identical across all four", () => {
  const plans = APPROACHES.map((a) => planVisitorAgent({ handle: `ap-${a}`, approach: a }));
  for (const p of plans) {
    assert.deepEqual(
      { ...p.strategy, launchNames: undefined },
      { ...plans[0].strategy, launchNames: undefined },
      `${p.approach} must not change hard limits`,
    );
  }
  assert.equal(planVisitorAgent({ handle: "noap" }).approach, "scout", "default approach");
  for (const a of APPROACHES) {
    assert.ok(APPROACH_WEIGHTS[a], `${a} has fallback weights`);
  }
});

test("a mandate is bounded prose", () => {
  const p = planVisitorAgent({
    handle: "briefed",
    mandate: "  Buy dips on PULSE only.\n Take profit fast. " + "x".repeat(400),
  });
  assert.ok(p.mandate && p.mandate.length <= 280, "mandate is clamped to 280 chars");
  const legacy = planVisitorAgent({ name: "misn", mission: "legacy field still works" });
  assert.equal(legacy.mandate, "legacy field still works");
});

test("bad handles are refused with a reason", () => {
  for (const handle of [undefined, "", "ab", "UPPER CASE", "-dash", "x".repeat(17), "anvil", "smiths", "treasury"]) {
    assert.throws(() => planVisitorAgent({ handle }), /./, `handle=${String(handle)} must be refused`);
  }
});

test("symbol collisions get a deterministic suffix; identity stays the handle", () => {
  const clean = planVisitorAgent({ handle: "test-1" });
  assert.equal(clean.symbol, "TEST1");
  const collided = planVisitorAgent({ handle: "test-1" }, new Set(["TEST1"]));
  assert.notEqual(collided.symbol, "TEST1");
  assert.match(collided.symbol, /^TEST1[A-Z0-9]{2}$/);
  assert.equal(collided.handle, "test-1", "the canonical identity is untouched");
  const again = planVisitorAgent({ handle: "test-1" }, new Set(["TEST1"]));
  assert.equal(again.symbol, collided.symbol, "suffix is deterministic");
});

test("a strategy survives the JSON round trip with bigints intact", () => {
  const { strategy } = planVisitorAgent({ handle: "roundtrip" });
  const back = deserializeStrategy(serializeStrategy(strategy));
  assert.deepEqual(back, strategy);
  assert.equal(typeof back.maxTradeUsdc, "bigint");
  assert.equal(typeof back.lookbackBlocks, "bigint");
});
