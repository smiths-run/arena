/**
 * The LLM boundary, attacked the way a confused or hostile model would cross
 * it: right shape, wrong content. Malformed proposals must become recorded
 * skips — never transactions — and well-formed ones must translate exactly,
 * because the policy engine's judgment is only as good as the action it sees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, toAction, type Proposal, type ProposalContext } from "./proposal.ts";
import { STRATEGIES } from "./config.ts";
import type { StrategistInput } from "./strategist.ts";

const base: Proposal = {
  kind: "skip",
  reason: "test",
  marketId: null,
  usdcIn: null,
  sellFraction: null,
  name: null,
  symbol: null,
};

const ctx: ProposalContext = {
  validMarketIds: new Set([0n, 3n]),
  positions: [{ marketId: 3n, tokens: 1_000_000n, costUsdc: 500_000n }],
  claimable: [{ marketId: 3n, amount: 42_000n }],
  strategy: STRATEGIES.anvil,
};

test("skip passes the model's reason through", () => {
  const a = toAction({ ...base, reason: "nothing qualified" }, ctx);
  assert.deepEqual(a, { kind: "skip", reason: "nothing qualified" });
});

test("a valid buy converts decimal USDC to base units", () => {
  const a = toAction({ ...base, kind: "buy", marketId: 3, usdcIn: 1.5 }, ctx);
  assert.deepEqual(a, { kind: "buy", marketId: 3n, usdcIn: 1_500_000n });
});

test("a buy on a market that does not exist becomes a recorded skip", () => {
  const a = toAction({ ...base, kind: "buy", marketId: 99, usdcIn: 1 }, ctx);
  assert.equal(a.kind, "skip");
  assert.match((a as { reason: string }).reason, /does not exist/);
});

test("a buy with a non-usable size becomes a recorded skip", () => {
  for (const usdcIn of [null, -1, 0, Number.NaN, Number.POSITIVE_INFINITY, 101]) {
    const a = toAction({ ...base, kind: "buy", marketId: 3, usdcIn }, ctx);
    assert.equal(a.kind, "skip", `usdcIn=${usdcIn} must not become a trade`);
  }
});

test("a sell takes the stated fraction of the recorded position", () => {
  const a = toAction({ ...base, kind: "sell", marketId: 3, sellFraction: 0.5 }, ctx);
  assert.deepEqual(a, { kind: "sell", marketId: 3n, tokens: 500_000n });
});

test("a sell without a position becomes a recorded skip", () => {
  const a = toAction({ ...base, kind: "sell", marketId: 0, sellFraction: 0.5 }, ctx);
  assert.equal(a.kind, "skip");
  assert.match((a as { reason: string }).reason, /no position/);
});

test("a sell fraction outside (0, 1] becomes a recorded skip", () => {
  for (const f of [null, 0, -0.5, 1.5, Number.NaN]) {
    const a = toAction({ ...base, kind: "sell", marketId: 3, sellFraction: f }, ctx);
    assert.equal(a.kind, "skip", `fraction=${f} must not become a trade`);
  }
});

test("a claim's amount comes from the chain, never from the model", () => {
  const a = toAction({ ...base, kind: "claim", marketId: 3 }, ctx);
  assert.deepEqual(a, { kind: "claim", marketId: 3n, amount: 42_000n });
});

test("a claim where nothing is claimable becomes a recorded skip", () => {
  const a = toAction({ ...base, kind: "claim", marketId: 0 }, ctx);
  assert.equal(a.kind, "skip");
  assert.match((a as { reason: string }).reason, /no claimable/);
});

test("a launch takes its initial buy from strategy, not the model", () => {
  const tongs = STRATEGIES.tongs;
  const a = toAction(
    { ...base, kind: "launch", name: "Ember", symbol: "EMBER" },
    { ...ctx, strategy: tongs },
  );
  assert.deepEqual(a, { kind: "launch", name: "Ember", symbol: "EMBER", initialBuy: tongs.launchBuyUsdc });
});

test("a launch with a malformed symbol becomes a recorded skip", () => {
  for (const symbol of [null, "x", "TOOLONGSYM", "lower", "WITH SPACE"]) {
    const a = toAction({ ...base, kind: "launch", name: "Ember", symbol }, ctx);
    assert.equal(a.kind, "skip", `symbol=${symbol} must not launch`);
  }
});

test("the prompt shows the agent its limits and the market snapshot", () => {
  const input: StrategistInput = {
    agentName: "anvil",
    address: "0x1111111111111111111111111111111111111111",
    description: "Test agent.",
    strategy: STRATEGIES.anvil,
    markets: [{ id: 3n, creator: "0x22", symbol: "PULSE", reserveUsdc: 2_000_000n, tradeCount: 7 } as never],
    recentTrades: [
      { marketId: 3n, trader: "0x3333333333333333333333333333333333333333", blockNumber: 990n } as never,
    ],
    blockNow: 1_000n,
    ownMarkets: 0,
  };
  const { system, user } = buildPrompt(input, {
    description: "Test agent.",
    positions: [{ marketId: 3n, tokens: 10n, costUsdc: 500_000n, valueUsdc: 510_000n }],
    claimable: [],
  });
  assert.match(system, /max 2\.0000 USDC per trade/);
  assert.match(system, /Skipping is a first-class outcome/);
  assert.match(user, /#3 PULSE/);
  assert.match(user, /liquidationValue=0\.5100/);
});
