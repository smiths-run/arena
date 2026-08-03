/**
 * The report's verdict is what a buyer pays for, so the rule that produces it is
 * pinned here rather than left to whatever the live chain happens to contain.
 *
 * `buildReport` reads the indexer over HTTP; these tests stub `fetch` so the
 * scoring runs against constructed histories, exercising both branches without
 * needing a chain in a particular state.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "./report.ts";

const CREATOR = "0xcreator000000000000000000000000000000001";
const OUTSIDER_A = "0xoutsidera00000000000000000000000000000a";
const OUTSIDER_B = "0xoutsiderb00000000000000000000000000000b";

interface Trade {
  marketId: string;
  trader: string;
  side: "buy" | "sell";
  usdc: string;
  blockNumber: string;
}

const realFetch = globalThis.fetch;

function stubIndexer(trades: Trade[]) {
  const market = {
    id: "1",
    symbol: "TEST",
    creator: CREATOR,
    tradeCount: trades.length,
    createdAtBlock: "1000",
  };
  globalThis.fetch = (async (input: Parameters<typeof realFetch>[0]) => {
    const url = String(input);
    const body = url.includes("/trades")
      ? { trades }
      : url.includes("/api/activity")
        ? { activity: trades }
        : url.includes("/api/markets/")
          ? market
          : { markets: [market] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function trade(trader: string, block: number, usdc = "1000000"): Trade {
  return { marketId: "1", trader, side: "buy", usdc, blockNumber: String(block) };
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a market only its creator has touched is high risk and unfavourable", async () => {
  stubIndexer([trade(CREATOR, 1000)]);
  const r = await buildReport("1");
  assert.equal(r.externalTraders, 0);
  assert.equal(r.risk, "high");
  assert.equal(r.verdict, "unfavourable");
  assert.match(r.findings[0], /No wallet other than the creator/);
});

test("a single outside buyer is medium risk — one counterparty is not a market", async () => {
  stubIndexer([trade(CREATOR, 1000), trade(OUTSIDER_A, 1100)]);
  const r = await buildReport("1");
  assert.equal(r.externalTraders, 1);
  assert.equal(r.topBuyerConcentration, 1);
  assert.equal(r.risk, "medium");
  assert.equal(r.verdict, "unfavourable");
  assert.ok(r.findings.some((f) => /single wallet/.test(f)));
});

test("two independent buyers with spread volume is low risk and favourable", async () => {
  stubIndexer([
    trade(CREATOR, 1000),
    trade(OUTSIDER_A, 1100, "1000000"),
    trade(OUTSIDER_B, 1200, "1500000"),
  ]);
  const r = await buildReport("1");
  assert.equal(r.externalTraders, 2);
  assert.ok(r.topBuyerConcentration < 0.9, "no single wallet dominates");
  assert.equal(r.risk, "low");
  assert.equal(r.verdict, "favourable");
});

test("concentration alone downgrades an otherwise broad market", async () => {
  // Two outsiders, but one of them is 99% of the volume.
  stubIndexer([
    trade(CREATOR, 1000),
    trade(OUTSIDER_A, 1100, "100000000"),
    trade(OUTSIDER_B, 1200, "1000"),
  ]);
  const r = await buildReport("1");
  assert.equal(r.externalTraders, 2);
  assert.ok(r.topBuyerConcentration >= 0.9);
  assert.equal(r.risk, "medium");
  assert.equal(r.verdict, "unfavourable");
});

test("external trade ratio and momentum are reported, not just the verdict", async () => {
  stubIndexer([
    trade(CREATOR, 1000),
    trade(OUTSIDER_A, 1100),
    trade(OUTSIDER_B, 1900),
    trade(OUTSIDER_A, 2000),
  ]);
  const r = await buildReport("1");
  assert.equal(r.tradeCount, 4);
  assert.ok(r.externalTradeRatio > 0.7, "three of four trades are external");
  assert.ok(r.momentum > 0, "recent activity is measured");
  assert.equal(r.marketId, "1");
  assert.equal(r.symbol, "TEST");
});
