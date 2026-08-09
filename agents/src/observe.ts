/**
 * What an agent is allowed to see: the public API (same one everyone gets) plus
 * its own wallet. Nothing here is privileged — a self-hosted agent could build
 * the identical picture from the indexer and the chain.
 */
import { createPublicClient, fallback, http, parseAbi } from "viem";
import { MARKETS, USDC } from "./shared.ts";

const API = process.env.INDEXER_URL ?? "http://localhost:42069";

const chainAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function quoteBuy(uint256 id, uint256 usdcIn) view returns (uint256 tokensOut, uint256 fee, uint256 impactBps)",
  "function quoteSell(uint256 id, uint256 tokensIn) view returns (uint256 usdcOut, uint256 fee, uint256 impactBps)",
  "function marketCount() view returns (uint256)",
  "function markets(uint256) view returns (address token, address creator, uint256 reserveUsdc, uint256 reserveToken, uint256 creatorFees, uint64 createdAtBlock)",
  "function symbol() view returns (string)",
]);

/** The two events that are flow: someone put money in, someone took it out. */
const flowAbi = parseAbi([
  "event Bought(uint256 indexed id, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
  "event Sold(uint256 indexed id, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
]);

/**
 * Every public Arc endpoint rate-limits individually (measured in M0), and a rate
 * limit comes back as a JSON-RPC error — a "successful" response, which viem's
 * fallback transport will not rotate on. So rotation is ours: one client per
 * endpoint, every call tries the pool round-robin, any failure moves to the next.
 * A private RPC via ARC_TESTNET_RPC_URL_PRIVATE bypasses the pool entirely.
 */
const URLS = process.env.ARC_TESTNET_RPC_URL_PRIVATE
  ? [process.env.ARC_TESTNET_RPC_URL_PRIVATE]
  : [
      // Blockdaemon's Arc node is pruned: historical eth_getLogs comes back as
      // error 4444, so it is no use to anything that reads the past.
      "https://rpc.testnet.arc.io",
      "https://rpc.quicknode.testnet.arc.io",
      "https://rpc.testnet.arc.network",
      "https://rpc.quicknode.testnet.arc.network",
    ];

const clients = URLS.map((u) =>
  createPublicClient({ transport: http(u, { retryCount: 0, timeout: 10_000 }) }),
);
let cursor = 0;

/**
 * Rate limits on these endpoints are per caller, not per endpoint: when the
 * host is hot, every URL in the pool refuses at once, and rotating through
 * them at full speed just burns the budget faster. So a failed pass waits
 * before the next one — measured in production, where a burst of eleven
 * eth_calls was enough to have all four endpoints answering "rate limit
 * exceeded" and every agent run erroring.
 */
const RETRY_PAUSE_MS = 600;

async function rotate<T>(call: (c: (typeof clients)[number]) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < clients.length * 2; attempt++) {
    const i = (cursor + attempt) % clients.length;
    try {
      const result = await call(clients[i]);
      cursor = i; // stick with a working endpoint until it fails
      return result;
    } catch (err) {
      lastErr = err;
      // A full pass over the pool means the limit is ours, not one endpoint's.
      if (attempt > 0 && (attempt + 1) % clients.length === 0) {
        await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
      }
    }
  }
  throw lastErr;
}

/**
 * Drop-in PublicClient: every method call runs through the rotation. Only method
 * calls are proxied — that is all any caller uses.
 */
export const pub = new Proxy({} as (typeof clients)[number], {
  get(_t, prop: string) {
    return (...args: unknown[]) => rotate((c) => (c as any)[prop](...args));
  },
});

export interface MarketView {
  id: bigint;
  creator: `0x${string}`;
  symbol: string;
  reserveUsdc: bigint;
  /** Lifetime trades, or null when nothing authoritative knows the total. */
  tradeCount: number | null;
}

export interface TradeView {
  marketId: bigint;
  trader: `0x${string}`;
  blockNumber: bigint;
  /** What the trade was. Strategy only counts flow; the site shows the trade. */
  side: "buy" | "sell";
  usdc: bigint;
  impactBps: bigint;
  txHash: `0x${string}`;
  logIndex: number;
}

/**
 * What a market is, as opposed to how it is doing. Id, token, creator and
 * symbol are fixed at launch and can never change, so they are read once and
 * kept; only the reserve moves, and it is refreshed on its own schedule.
 *
 * This matters because the host, not the endpoint, is what gets rate limited:
 * rebuilding the whole list from the chain on every run put twenty-odd
 * eth_calls into a budget that allows a couple, and every agent run failed.
 */
interface MarketFacts {
  id: bigint;
  token: `0x${string}`;
  creator: `0x${string}`;
  symbol: string;
}

const known = new Map<string, MarketFacts>();
const reserves = new Map<string, bigint>();

/** How long a market list may be reused before the chain is asked again. */
const MARKETS_TTL_MS = 30_000;
let checkedAt = 0;

/**
 * Every market, read from the chain.
 *
 * This deliberately does not go through the indexer. An agent's world must not
 * be smaller than the chain's: a market launched a minute ago is real, tradable
 * and competing for flow whether or not a backfill has caught up with it. Ours
 * fell exactly that way — the indexer sat a million blocks behind, so ten of
 * eleven markets were invisible and every agent kept concluding there was
 * nothing to trade.
 */
export async function fetchMarkets(): Promise<MarketView[]> {
  const stale = Date.now() - checkedAt >= MARKETS_TTL_MS;

  if (stale || known.size === 0) {
    const count = (await pub.readContract({
      address: MARKETS as `0x${string}`,
      abi: chainAbi,
      functionName: "marketCount",
    })) as bigint;

    // Only ids we have never seen cost anything: markets are append-only, so a
    // steady state is one eth_call per window no matter how many exist.
    for (let id = 0n; id < count; id++) {
      const key = id.toString();
      if (known.has(key)) continue;
      const [token, creator, reserveUsdc] = (await pub.readContract({
        address: MARKETS as `0x${string}`,
        abi: chainAbi,
        functionName: "markets",
        args: [id],
      })) as [`0x${string}`, `0x${string}`, bigint, bigint, bigint, bigint];
      const symbol = (await pub
        .readContract({ address: token, abi: chainAbi, functionName: "symbol" })
        .catch(() => "")) as string;
      known.set(key, { id, token, creator, symbol });
      reserves.set(key, reserveUsdc);
    }

    // A symbol read that lost to a rate limit must not become permanent: the
    // market is fixed, our knowledge of it is not. EMBER shipped nameless
    // exactly this way. Retry the blanks — the rest of the row stays usable
    // meanwhile.
    for (const m of known.values()) {
      if (m.symbol) continue;
      const symbol = (await pub
        .readContract({ address: m.token, abi: chainAbi, functionName: "symbol" })
        .catch(() => "")) as string;
      if (symbol) known.set(m.id.toString(), { ...m, symbol });
    }

    checkedAt = Date.now();
  }

  return [...known.values()].map((m) => ({
    id: m.id,
    creator: m.creator,
    symbol: m.symbol,
    reserveUsdc: reserves.get(m.id.toString()) ?? 0n,
    // Lifetime totals are a history question and the chain does not keep a
    // counter; null says "unknown" so scoring falls back to the flow window
    // instead of reading it as "never traded".
    tradeCount: null,
  }));
}

/**
 * How far back "recent" reaches. Arc's public endpoints cap eth_getLogs at a
 * 10,000-block range and count both ends, so the window is one short of the cap
 * — asking for exactly 10,000 back makes it 10,001 blocks and is refused.
 */
const FLOW_WINDOW_BLOCKS = 9_999n;

/**
 * Recent buys and sells, read from the chain's own logs rather than the
 * indexer. One eth_getLogs over the flow window — the same range every public
 * Arc endpoint accepts — so an agent's sense of who is trading is never older
 * than the last block.
 */
let flowCache: { at: number; trades: TradeView[] } | null = null;

export async function fetchRecentTrades(): Promise<TradeView[]> {
  // Every agent in this process asks on every run, and the window moves by
  // seconds — one read serves them all.
  if (flowCache && Date.now() - flowCache.at < MARKETS_TTL_MS) return flowCache.trades;

  const head = await currentBlock();
  const fromBlock = head > FLOW_WINDOW_BLOCKS ? head - FLOW_WINDOW_BLOCKS : 0n;
  const logs = (await pub.getLogs({
    address: MARKETS as `0x${string}`,
    events: flowAbi,
    fromBlock,
    toBlock: head,
  })) as Array<{
    eventName: "Bought" | "Sold";
    args: {
      id?: bigint;
      buyer?: `0x${string}`;
      seller?: `0x${string}`;
      usdcIn?: bigint;
      usdcOut?: bigint;
      impactBps?: bigint;
    };
    blockNumber: bigint;
    transactionHash: `0x${string}`;
    logIndex: number;
  }>;

  const trades = logs
    .filter((l) => l.args.id !== undefined)
    .map((l) => ({
      marketId: l.args.id as bigint,
      trader: (l.args.buyer ?? l.args.seller) as `0x${string}`,
      blockNumber: l.blockNumber,
      side: (l.eventName === "Bought" ? "buy" : "sell") as "buy" | "sell",
      usdc: (l.args.usdcIn ?? l.args.usdcOut ?? 0n) as bigint,
      impactBps: (l.args.impactBps ?? 0n) as bigint,
      txHash: l.transactionHash,
      logIndex: l.logIndex,
    }));
  flowCache = { at: Date.now(), trades };
  return trades;
}

/**
 * Markets this address has created, read from the chain.
 *
 * The indexer is eventually consistent, and a hard limit must never be decided
 * against a lagging source: an agent that launched a market seconds ago is still
 * under its cap as far as the indexer is concerned, and will launch again. That
 * is not hypothetical — it is how one agent here ended up with three markets
 * against a cap of two.
 */
export async function ownMarketCountOnChain(address: `0x${string}`): Promise<number> {
  // A creator is fixed at launch, so the market registry above already holds
  // the answer — and it is the chain's answer, refreshed against marketCount,
  // not the indexer's. Walking every market with its own eth_call is what put
  // this read over the host's rate limit in the first place.
  const markets = await fetchMarkets();
  const me = address.toLowerCase();
  return markets.filter((m) => m.creator.toLowerCase() === me).length;
}

/** Creator fees this address can claim, per market, read from the chain. */
export async function claimableFees(
  address: `0x${string}`,
): Promise<Array<{ marketId: bigint; amount: bigint }>> {
  const count = await pub.readContract({
    address: MARKETS as `0x${string}`,
    abi: chainAbi,
    functionName: "marketCount",
  });

  const out: Array<{ marketId: bigint; amount: bigint }> = [];
  for (let i = 0n; i < count; i++) {
    const [, creator, , , fees] = await pub.readContract({
      address: MARKETS as `0x${string}`,
      abi: chainAbi,
      functionName: "markets",
      args: [i],
    });
    if (creator.toLowerCase() === address.toLowerCase() && fees > 0n) {
      out.push({ marketId: i, amount: fees });
    }
  }
  return out;
}

export async function walletUsdc(address: `0x${string}`): Promise<bigint> {
  return pub.readContract({ address: USDC, abi: chainAbi, functionName: "balanceOf", args: [address] });
}

export async function currentBlock(): Promise<bigint> {
  return pub.getBlockNumber();
}

export async function quoteBuy(
  marketId: bigint,
  usdcIn: bigint,
): Promise<{ tokensOut: bigint; impactBps: bigint }> {
  const [tokensOut, , impactBps] = await pub.readContract({
    address: MARKETS as `0x${string}`,
    abi: chainAbi,
    functionName: "quoteBuy",
    args: [marketId, usdcIn],
  });
  return { tokensOut, impactBps };
}

export async function quoteSell(
  marketId: bigint,
  tokensIn: bigint,
): Promise<{ usdcOut: bigint; impactBps: bigint }> {
  const [usdcOut, , impactBps] = await pub.readContract({
    address: MARKETS as `0x${string}`,
    abi: chainAbi,
    functionName: "quoteSell",
    args: [marketId, tokensIn],
  });
  return { usdcOut, impactBps };
}
