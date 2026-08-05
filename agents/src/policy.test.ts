import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type Observation } from "./policy.ts";
import { STRATEGIES } from "./config.ts";

const anvil = STRATEGIES.anvil;

const base: Observation = {
  balanceUsdc: 10_000_000n,
  spent24h: 0n,
  quotedImpactBps: 100n,
  positionTokens: 0n,
  ownMarketCount: 0,
};

test("a permitted buy inside every limit passes", () => {
  const v = evaluate({ kind: "buy", marketId: 0n, usdcIn: 1_000_000n }, anvil, base);
  assert.deepEqual(v, { ok: true });
});

test("skip is always a valid outcome", () => {
  const v = evaluate({ kind: "skip", reason: "nothing qualified" }, anvil, base);
  assert.deepEqual(v, { ok: true });
});

test("an action the strategy does not allow is rejected", () => {
  const v = evaluate({ kind: "launch", name: "X", symbol: "X", initialBuy: 1_000_000n }, anvil, base);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /not permitted/);
});

test("max trade is enforced", () => {
  const v = evaluate({ kind: "buy", marketId: 0n, usdcIn: anvil.maxTradeUsdc + 1n }, anvil, base);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /max trade/);
});

test("the strategy cannot exceed the contract's hard ceilings", () => {
  const reckless = { ...anvil, maxTradeUsdc: 50_000_000n, maxImpactBps: 9_000n };
  const tooBig = evaluate({ kind: "buy", marketId: 0n, usdcIn: 6_000_000n }, reckless, {
    ...base,
    balanceUsdc: 100_000_000n,
    quotedImpactBps: 100n,
  });
  assert.equal(tooBig.ok, false, "5 USDC contract cap holds even when strategy says 50");

  const tooDeep = evaluate({ kind: "buy", marketId: 0n, usdcIn: 1_000_000n }, reckless, {
    ...base,
    quotedImpactBps: 600n,
  });
  assert.equal(tooDeep.ok, false, "500 bps contract cap holds even when strategy says 9000");
});

test("daily spend cap counts what was already spent", () => {
  const v = evaluate({ kind: "buy", marketId: 0n, usdcIn: 2_000_000n }, anvil, {
    ...base,
    spent24h: anvil.dailySpendUsdc - 1_000_000n,
  });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /daily cap/);
});

test("the operating reserve is untouchable", () => {
  const v = evaluate({ kind: "buy", marketId: 0n, usdcIn: 1_000_000n }, anvil, {
    ...base,
    balanceUsdc: 1_400_000n, // 1.0 buy + 0.5 reserve needs 1.5
  });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /reserve/);
});

test("no quote means no trade", () => {
  const v = evaluate({ kind: "buy", marketId: 0n, usdcIn: 1_000_000n }, anvil, {
    ...base,
    quotedImpactBps: null,
  });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /blind/);
});

test("impact above the agent's own cap is rejected", () => {
  const v = evaluate({ kind: "buy", marketId: 0n, usdcIn: 1_000_000n }, anvil, {
    ...base,
    quotedImpactBps: anvil.maxImpactBps + 1n,
  });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /impact/);
});

test("a blocked market is untradeable in both directions", () => {
  const s = { ...anvil, blockedMarkets: [7n] };
  for (const action of [
    { kind: "buy", marketId: 7n, usdcIn: 1_000_000n } as const,
    { kind: "sell", marketId: 7n, tokens: 10n } as const,
  ]) {
    const v = evaluate(action, s, { ...base, positionTokens: 100n });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /blocked/);
  }
});

test("selling more than the recorded position is rejected", () => {
  const v = evaluate({ kind: "sell", marketId: 0n, tokens: 101n }, anvil, {
    ...base,
    positionTokens: 100n,
  });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /exceeds recorded position/);
});

test("a claim worth less than its gas is rejected", () => {
  const v = evaluate({ kind: "claim", marketId: 0n, amount: 100n }, anvil, base);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /not worth the gas/);
});

test("a claim worth collecting passes", () => {
  const v = evaluate({ kind: "claim", marketId: 0n, amount: 16_500n }, anvil, base);
  assert.deepEqual(v, { ok: true });
});

test("a claim the strategy does not permit is refused", () => {
  const noClaim = { ...anvil, allowedActions: ["buy" as const] };
  const v = evaluate({ kind: "claim", marketId: 0n, amount: 16_500n }, noClaim, base);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /not permitted/);
});

test("the reserve check keeps back gas headroom", () => {
  // Exactly spend + reserve, with nothing left for the transaction's own gas.
  const v = evaluate({ kind: "buy", marketId: 0n, usdcIn: 1_000_000n }, anvil, {
    ...base,
    balanceUsdc: 1_000_000n + anvil.operatingReserveUsdc,
  });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /gas headroom/);
});

/**
 * The cap once failed in production because ownMarketCount came from the indexer,
 * which lags the chain: an agent that had just launched still read as under its
 * cap and launched again, ending with three markets against a limit of two. The
 * policy engine was never wrong — it was fed a stale number. This pins the
 * contract between them: whatever the caller passes must already include
 * everything confirmed and in flight.
 */
test("the own-market cap binds on the count it is given, including in-flight", () => {
  const tongs = STRATEGIES.tongs;
  const confirmed = tongs.maxOwnMarkets - 1;

  const underCap = evaluate(
    { kind: "launch", name: "Ember", symbol: "EMBER", initialBuy: 1_000_000n },
    tongs,
    { ...base, ownMarketCount: confirmed },
  );
  assert.deepEqual(underCap, { ok: true }, "one below the cap may still launch");

  // Same confirmed count, but one launch is in flight. The caller must add it.
  const withInFlight = evaluate(
    { kind: "launch", name: "Ember", symbol: "EMBER", initialBuy: 1_000_000n },
    tongs,
    { ...base, ownMarketCount: confirmed + 1 },
  );
  assert.equal(withInFlight.ok, false, "counting the in-flight launch closes the cap");
  assert.match((withInFlight as { reason: string }).reason, /own-market cap/);
});

test("launch respects the own-market cap", () => {
  const tongs = STRATEGIES.tongs;
  const v = evaluate(
    { kind: "launch", name: "Ember", symbol: "EMBER", initialBuy: 1_000_000n },
    tongs,
    { ...base, ownMarketCount: tongs.maxOwnMarkets },
  );
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /own-market cap/);
});
