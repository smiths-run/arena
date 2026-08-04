/**
 * The analyst's product: a market-intelligence report computed from indexed
 * onchain history.
 *
 * The report exists because a trader's own signal is weak in a specific,
 * checkable way. A trader can see *that* a market has recent trades; it cannot
 * cheaply see how many distinct wallets are behind them, how concentrated the
 * buying is, or what the creator's other markets did. That needs the market's
 * trade history joined against its creator, which is what the analyst computes.
 *
 * Everything here is derived from public data. The value is not secrecy; it is
 * the work of computing it, and that is what a buyer pays for.
 *
 * What this does NOT establish, and must not be sold as:
 *
 *   - **Independence.** "External" here means an address other than the
 *     creator's. One person with two wallets, or two colluding agents, reads as
 *     two external traders. ERC-8004 identity does not solve Sybil either. The
 *     report measures wallet diversity, not distinct people.
 *   - **Completeness.** The indexer is queried with limits (500 trades per
 *     market, 500 recent trades globally, 100 markets). On a small testnet that
 *     covers everything; at scale these become samples, and the fields below
 *     become approximations rather than totals.
 */
const INDEXER = process.env.INDEXER_URL ?? "http://localhost:42069";

export interface Report {
  marketId: string;
  symbol: string;
  generatedAtBlock: string;
  /** Trades in the market's whole indexed life. */
  tradeCount: number;
  /** Distinct addresses that are not the creator. Not proof of distinct people. */
  externalTraders: number;
  /** Share of trades placed by someone other than the creator, 0–1. */
  externalTradeRatio: number;
  /** Share of external buy volume sitting in the single largest external buyer, 0–1. */
  topBuyerConcentration: number;
  /** Trades in the last quarter of the market's block life vs the rest, as a ratio. */
  momentum: number;
  /** Creator's other markets and how much outside flow they attracted. */
  creatorMarkets: number;
  creatorExternalTradesAllTime: number;
  risk: "low" | "medium" | "high";
  verdict: "favourable" | "unfavourable";
  findings: string[];
}

interface RawMarket {
  id: string;
  symbol: string;
  creator: string;
  tradeCount: number;
  createdAtBlock: string;
}

interface RawTrade {
  marketId: string;
  trader: string;
  side: "buy" | "sell";
  usdc: string;
  blockNumber: string;
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${INDEXER}${path}`, { cache: "no-store" } as RequestInit);
  if (!res.ok) throw new Error(`indexer ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export async function buildReport(marketId: string): Promise<Report> {
  const [market, { trades }, { markets }, { activity }] = await Promise.all([
    api<RawMarket>(`/api/markets/${marketId}`),
    api<{ trades: RawTrade[] }>(`/api/markets/${marketId}/trades?limit=500`),
    api<{ markets: RawMarket[] }>(`/api/markets?limit=100`),
    api<{ activity: RawTrade[] }>(`/api/activity?limit=500`),
  ]);

  const creator = market.creator.toLowerCase();
  const external = trades.filter((t) => t.trader.toLowerCase() !== creator);
  const externalTraders = new Set(external.map((t) => t.trader.toLowerCase()));

  // Concentration: how much of external buy volume is one wallet?
  const buyVolumeByTrader = new Map<string, bigint>();
  for (const t of external) {
    if (t.side !== "buy") continue;
    const k = t.trader.toLowerCase();
    buyVolumeByTrader.set(k, (buyVolumeByTrader.get(k) ?? 0n) + BigInt(t.usdc));
  }
  const totalExternalBuy = [...buyVolumeByTrader.values()].reduce((a, b) => a + b, 0n);
  const topBuy = [...buyVolumeByTrader.values()].reduce((a, b) => (b > a ? b : a), 0n);
  const topBuyerConcentration =
    totalExternalBuy > 0n ? Number((topBuy * 10_000n) / totalExternalBuy) / 10_000 : 0;

  // Momentum: trades in the most recent quarter of the market's life vs the rest.
  const blocks = trades.map((t) => BigInt(t.blockNumber));
  const first = BigInt(market.createdAtBlock);
  const last = blocks.length > 0 ? blocks.reduce((a, b) => (b > a ? b : a), first) : first;
  const span = last - first;
  const cutoff = span > 0n ? last - span / 4n : first;
  const recent = trades.filter((t) => BigInt(t.blockNumber) >= cutoff).length;
  const earlier = trades.length - recent;
  const momentum = earlier > 0 ? recent / earlier : recent > 0 ? 1 : 0;

  // The creator's track record across every market it has launched.
  const creatorMarketIds = new Set(
    markets.filter((m) => m.creator.toLowerCase() === creator).map((m) => m.id),
  );
  const creatorExternalTradesAllTime = activity.filter(
    (t) => creatorMarketIds.has(t.marketId) && t.trader.toLowerCase() !== creator,
  ).length;

  const externalTradeRatio = trades.length > 0 ? external.length / trades.length : 0;

  const findings: string[] = [];
  if (externalTraders.size === 0) {
    findings.push("No wallet other than the creator has ever traded this market.");
  } else {
    findings.push(
      `${externalTraders.size} external wallet${externalTraders.size === 1 ? "" : "s"} account for ` +
        `${(externalTradeRatio * 100).toFixed(0)}% of trades.`,
    );
  }
  if (topBuyerConcentration >= 0.99 && externalTraders.size === 1) {
    findings.push(
      "All external buying comes from a single wallet — the flow is one counterparty, not a market.",
    );
  }
  findings.push(
    momentum >= 1
      ? "Activity is concentrated in the most recent quarter of this market's life."
      : "Activity has slowed relative to the market's earlier history.",
  );
  findings.push(
    `Creator has launched ${creatorMarketIds.size} market${creatorMarketIds.size === 1 ? "" : "s"} ` +
      `attracting ${creatorExternalTradesAllTime} external trade${creatorExternalTradesAllTime === 1 ? "" : "s"} in total.`,
  );

  // Risk and verdict. The single decisive question a trader cannot answer alone:
  // is there more than one independent buyer?
  let risk: Report["risk"];
  if (externalTraders.size === 0) risk = "high";
  else if (externalTraders.size === 1 || topBuyerConcentration >= 0.9) risk = "medium";
  else risk = "low";

  const verdict: Report["verdict"] =
    risk === "low" && momentum > 0 ? "favourable" : "unfavourable";

  return {
    marketId: market.id,
    symbol: market.symbol,
    generatedAtBlock: last.toString(),
    tradeCount: market.tradeCount,
    externalTraders: externalTraders.size,
    externalTradeRatio: Number(externalTradeRatio.toFixed(4)),
    topBuyerConcentration: Number(topBuyerConcentration.toFixed(4)),
    momentum: Number(momentum.toFixed(4)),
    creatorMarkets: creatorMarketIds.size,
    creatorExternalTradesAllTime,
    risk,
    verdict,
    findings,
  };
}
