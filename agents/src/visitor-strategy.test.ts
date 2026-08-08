/**
 * The visitor boundary: whatever a visitor types, the resulting strategy must
 * sit inside the same regime the house agents live under — and the strategy
 * must survive its round trip through JSON with every bigint intact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planVisitorAgent,
  serializeStrategy,
  deserializeStrategy,
} from "./visitor-strategy.ts";

test("a plain name yields a bounded strategy and its own launch token", () => {
  const p = planVisitorAgent({ name: "Forge", risk: "balanced" });
  assert.equal(p.name, "forge");
  assert.equal(p.symbol, "FORGE");
  assert.deepEqual(p.strategy.launchNames, [{ name: "forge", symbol: "FORGE" }]);
  assert.equal(p.strategy.maxOwnMarkets, 1);
  assert.ok(p.strategy.maxTradeUsdc <= 2_000_000n, "never above the house trader's cap");
  assert.equal(p.strategy.llm.enabled, false, "inference is our bill, not theirs");
  assert.equal(p.strategy.operatingReserveUsdc, 500_000n);
});

test("risk levels change size and stops, nothing else escapes the clamp", () => {
  const bold = planVisitorAgent({ name: "bold-one", risk: "bold" });
  const cautious = planVisitorAgent({ name: "cautious-one", risk: "cautious" });
  assert.ok(bold.strategy.maxTradeUsdc > cautious.strategy.maxTradeUsdc);
  assert.ok(bold.strategy.maxTradeUsdc <= 2_000_000n);
  assert.equal(bold.strategy.maxImpactBps, 450n, "impact ceiling is not tunable");
});

test("an unknown risk level falls back to balanced", () => {
  const p = planVisitorAgent({ name: "meh", risk: "yolo" });
  assert.equal(p.strategy.maxTradeUsdc, 1_000_000n);
});

test("bad names are refused with a reason", () => {
  for (const name of [undefined, "", "ab", "UPPER CASE", "-dash", "x".repeat(17), "anvil", "tongs"]) {
    assert.throws(() => planVisitorAgent({ name }), /./, `name=${String(name)} must be refused`);
  }
});

test("a strategy survives the JSON round trip with bigints intact", () => {
  const { strategy } = planVisitorAgent({ name: "roundtrip" });
  const back = deserializeStrategy(serializeStrategy(strategy));
  assert.deepEqual(back, strategy);
  assert.equal(typeof back.maxTradeUsdc, "bigint");
  assert.equal(typeof back.lookbackBlocks, "bigint");
  assert.equal(back.launchNames?.[0]?.symbol, "ROUNDTRI");
});
