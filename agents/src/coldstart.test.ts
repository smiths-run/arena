/**
 * The cold start: what an agent may do when nothing has traded at all.
 *
 * "Only enter where others already trade" deadlocks an empty economy — every
 * agent waits for a first move none of them is allowed to make, which is
 * exactly what happened here: eleven markets, zero trades in ten thousand
 * blocks, every agent skipping. The exception must be narrow, so these tests
 * pin both halves: it opens when the window is truly empty, and it stays out
 * of the way the moment any flow exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STRATEGIES, type Strategy } from "./config.ts";
import type { MarketView, TradeView } from "./observe.ts";
import type { StrategistInput } from "./strategist.ts";

// The cold start asks the ledger whether this agent already holds anything, so
// the ledger must be a fresh one — pointed at a throwaway directory before the
// store is imported, or these tests would read whatever the live agents did.
process.env.AGENTS_DATA_DIR = mkdtempSync(join(tmpdir(), "smiths-coldstart-"));
const { heuristicStrategist } = await import("./strategist.ts");

const ME: `0x${string}` = "0x1111111111111111111111111111111111111111";
const OTHER: `0x${string}` = "0x2222222222222222222222222222222222222222";

function market(id: bigint, creator: `0x${string}` = OTHER): MarketView {
  return { id, token: "0x0000000000000000000000000000000000000dad", creator, symbol: `M${id}`, name: `Market ${id}`, reserveUsdc: 126_000_000n, tradeCount: null };
}

function trade(marketId: bigint, blockNumber: bigint, trader: `0x${string}` = OTHER): TradeView {
  return {
    marketId,
    trader,
    blockNumber,
    side: "buy",
    usdc: 1_000_000n,
    impactBps: 10n,
    txHash: "0xabc" as `0x${string}`,
    logIndex: 0,
  };
}

function input(over: Partial<StrategistInput> = {}): StrategistInput {
  return {
    agentName: "anvil",
    address: ME,
    description: "test",
    approach: "momentum",
    // anvil buys only; no claim or launch path can answer first.
    strategy: { ...STRATEGIES.anvil, allowedActions: ["buy"] } as Strategy,
    markets: [market(0n), market(1n), market(2n)],
    recentTrades: [],
    blockNow: 100_000n,
    ownMarkets: 0,
    ...over,
  };
}

test("an empty window opens one position instead of waiting forever", async () => {
  const action = await heuristicStrategist(input());
  assert.equal(action.kind, "buy");
  if (action.kind !== "buy") return;
  // The smallest size the agent trades, not its maximum.
  assert.ok(action.usdcIn <= 500_000n, `opened with ${action.usdcIn}, expected ≤ 0.5 USDC`);
});

test("the opening is never in a market the agent created itself", async () => {
  const markets = [market(0n, ME), market(1n, ME), market(2n)];
  const action = await heuristicStrategist(input({ markets }));
  assert.equal(action.kind, "buy");
  if (action.kind !== "buy") return;
  assert.equal(action.marketId, 2n);
});

test("agents do not all crowd the same market", async () => {
  const markets = Array.from({ length: 8 }, (_, i) => market(BigInt(i)));
  const picks = new Set<string>();
  for (const agentName of ["anvil", "bellows", "tongs", "bobo", "gomez"]) {
    const action = await heuristicStrategist(input({ agentName, markets }));
    if (action.kind === "buy") picks.add(action.marketId.toString());
  }
  assert.ok(picks.size > 1, `every agent picked the same market: ${[...picks]}`);
});

test("the same agent always opens in the same market — a restart does not re-roll", async () => {
  const markets = Array.from({ length: 8 }, (_, i) => market(BigInt(i)));
  const first = await heuristicStrategist(input({ markets }));
  const again = await heuristicStrategist(input({ markets }));
  assert.equal(first.kind, "buy");
  if (first.kind !== "buy" || again.kind !== "buy") return;
  assert.equal(first.marketId, again.marketId);
});

test("once any flow exists the evidence gate applies again", async () => {
  // One trade, in the window, by someone else — below anvil's threshold of 1?
  // No: exactly at it, so this must be a normal ranked buy, not a cold start.
  const recentTrades = [trade(1n, 99_900n)];
  const action = await heuristicStrategist(input({ recentTrades }));
  assert.equal(action.kind, "buy");
  if (action.kind !== "buy") return;
  assert.equal(action.marketId, 1n, "should buy the market with flow, not a cold-start pick");
});

test("flow that is only our own does not count as flow", async () => {
  // Our own trades are excluded from the stats, so this is still a cold start
  // rather than evidence that a market is alive.
  const recentTrades = [trade(1n, 99_900n, ME), trade(2n, 99_950n, ME)];
  const action = await heuristicStrategist(input({ recentTrades }));
  assert.equal(action.kind, "buy");
  if (action.kind !== "buy") return;
  assert.ok(action.usdcIn <= 500_000n, "an all-self window should still open at cold-start size");
});

test("the cold start fires once, not every run", async () => {
  // An agent's own trades are excluded from the flow stats, so after opening
  // it would find the window just as empty and buy again — and again — until
  // the daily cap stopped it. Holding something is the signal to stop.
  const store = await import("./store.ts");
  const first = await heuristicStrategist(input({ agentName: "opener" }));
  assert.equal(first.kind, "buy");
  if (first.kind !== "buy") return;

  store.positionAdd("opener", first.marketId, 1_000_000n, first.usdcIn);

  const second = await heuristicStrategist(input({ agentName: "opener" }));
  assert.equal(second.kind, "skip", `expected a skip, got ${second.kind}`);
});

test("a blocked market is never the opening", async () => {
  const strategy: Strategy = { ...STRATEGIES.anvil, allowedActions: ["buy"], blockedMarkets: [0n, 1n] };
  const markets = [market(0n), market(1n), market(2n)];
  const action = await heuristicStrategist(input({ strategy, markets }));
  assert.equal(action.kind, "buy");
  if (action.kind !== "buy") return;
  assert.equal(action.marketId, 2n);
});
