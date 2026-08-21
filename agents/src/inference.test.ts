/**
 * Pricing the thinking.
 *
 * The point of this report is that somebody can look at it and decide what to
 * charge an agent per thought. That only works if the arithmetic is right at
 * the small end — a single call is worth cents, and an economy of them is worth
 * caring about — and if the report never quietly implies the cost is already
 * being charged.
 *
 * The store reads config at import, so the environment is stood up first and
 * the imports are dynamic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTS_DATA_DIR = mkdtempSync(join(tmpdir(), "agents-inference-test-"));
process.env.MARKETS_ADDRESS ??= "0x0000000000000000000000000000000000000001";
process.env.CIRCLE_API_KEY ??= "test";
process.env.CIRCLE_ENTITY_SECRET ??= "test";
for (const i of [0, 1, 2]) {
  process.env[`AGENT_${i}_WALLET_ID`] ??= `w-${i}`;
  process.env[`AGENT_${i}_ADDRESS`] ??= `0x${String(i).repeat(40)}`;
}

const store = await import("./store.ts");
const inf = await import("./inference.ts");

test("a call is priced at the published rate for its model", () => {
  // 1M in + 1M out on opus-5 is $5 + $25.
  assert.equal(inf.costOf("claude-opus-5", 1_000_000, 1_000_000), 30_000_000n);
  // Haiku is the cheap row: $1 + $5.
  assert.equal(inf.costOf("claude-haiku-4-5", 1_000_000, 1_000_000), 6_000_000n);
});

test("a realistic strategist call lands in cents, not dollars", () => {
  // ~10k in, ~1.5k out on opus-5: $0.05 + $0.0375.
  const c = inf.costOf("claude-opus-5", 10_000, 1_500);
  assert.equal(c, 87_500n);
  assert.ok(c > 50_000n && c < 150_000n, `expected cents, got ${c}`);
});

test("a sub-unit call still costs something", () => {
  // Rounding this down to zero is how a ledger starts lying at scale.
  assert.equal(inf.costOf("claude-haiku-4-5", 1, 0), 1n);
});

test("an unknown model is priced pessimistically, and says so", () => {
  assert.equal(inf.isPriced("claude-opus-5"), true);
  assert.equal(inf.isPriced("some-future-model"), false);
  // The fallback is the most expensive row, never zero.
  assert.ok(inf.costOf("some-future-model", 1_000_000, 0) >= inf.costOf("claude-opus-5", 1_000_000, 0));
});

test("usage groups by agent and by model, and totals agree", () => {
  store.llmCallRecord("anvil", "claude-opus-5", 10_000, 1_000);
  store.llmCallRecord("anvil", "claude-opus-5", 20_000, 2_000);
  store.llmCallRecord("bellows", "claude-haiku-4-5", 5_000, 500);

  const r = inf.usage(0);
  assert.equal(r.calls, 3);
  assert.equal(r.tokensIn, 35_000);
  assert.equal(r.tokensOut, 3_500);

  const perModel = r.byModel.reduce((s, m) => s + BigInt(m.costUsdc), 0n);
  const perAgent = r.byAgent.reduce((s, a) => s + BigInt(a.costUsdc), 0n);
  assert.equal(perModel, BigInt(r.costUsdc));
  assert.equal(perAgent, BigInt(r.costUsdc));

  // The costliest agent leads, so a reader sees the bill before the detail.
  assert.equal(r.byAgent[0].agent, "anvil");
  assert.equal(r.byAgent[0].calls, 2);
});

test("the report never implies the cost has been charged", () => {
  const r = inf.usage(0);
  assert.match(r.note, /not charged/i);

  // netOfInference is strictly worse than the published net result, because
  // thinking is a cost that the published number does not yet carry.
  for (const a of r.byAgent) {
    assert.equal(
      BigInt(a.netOfInferenceUsdc),
      BigInt(a.netResultUsdc) - BigInt(a.costUsdc),
    );
    assert.ok(BigInt(a.netOfInferenceUsdc) <= BigInt(a.netResultUsdc));
  }
});

test("an empty window reports zero rather than dividing by it", () => {
  const r = inf.usage(Date.now() + 60_000);
  assert.equal(r.calls, 0);
  assert.equal(r.costUsdc, "0");
  assert.equal(r.costPerCallUsdc, "0");
});
