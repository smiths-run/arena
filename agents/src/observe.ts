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
}

/** Token symbols never change, so one read per token lasts the process. */
const symbolCache = new Map<string, string>();

/**
 * The market list changes only when someone launches, and every agent in this
 * process asks for it on every run. Without a cache that is a dozen chain reads
 * per agent per run, which is how the public endpoints start refusing us.
 */
const MARKETS_TTL_MS = 20_000;
let marketsCache: { at: number; markets: MarketView[] } | null = null;

async function symbolOf(token: `0x${string}`): Promise<string> {
  const hit = symbolCache.get(token.toLowerCase());
  if (hit) return hit;
  const symbol = await pub
    .readContract({ address: token, abi: chainAbi, functionName: "symbol" })
    .catch(() => "");
  if (symbol) symbolCache.set(token.toLowerCase(), symbol as string);
  return (symbol as string) ?? "";
}

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
  if (marketsCache && Date.now() - marketsCache.at < MARKETS_TTL_MS) return marketsCache.markets;

  const count = (await pub.readContract({
    address: MARKETS as `0x${string}`,
    abi: chainAbi,
    functionName: "marketCount",
  })) as bigint;

  const markets: MarketView[] = [];
  for (let id = 0n; id < count; id++) {
    const [token, creator, reserveUsdc] = (await pub.readContract({
      address: MARKETS as `0x${string}`,
      abi: chainAbi,
      functionName: "markets",
      args: [id],
    })) as [`0x${string}`, `0x${string}`, bigint, bigint, bigint, bigint];
    markets.push({
      id,
      creator,
      symbol: await symbolOf(token),
      reserveUsdc,
      // Lifetime totals are a history question and the chain does not keep a
      // counter; null says "unknown" so scoring falls back to the flow window
      // instead of reading it as "never traded".
      tradeCount: null,
    });
  }
  marketsCache = { at: Date.now(), markets };
  return markets;
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
export async function fetchRecentTrades(): Promise<TradeView[]> {
  const head = await currentBlock();
  const fromBlock = head > FLOW_WINDOW_BLOCKS ? head - FLOW_WINDOW_BLOCKS : 0n;
  const logs = (await pub.getLogs({
    address: MARKETS as `0x${string}`,
    events: flowAbi,
    fromBlock,
    toBlock: head,
  })) as Array<{
    args: { id?: bigint; buyer?: `0x${string}`; seller?: `0x${string}` };
    blockNumber: bigint;
  }>;

  return logs
    .filter((l) => l.args.id !== undefined)
    .map((l) => ({
      marketId: l.args.id as bigint,
      trader: (l.args.buyer ?? l.args.seller) as `0x${string}`,
      blockNumber: l.blockNumber,
    }));
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
  const count = await pub.readContract({
    address: MARKETS as `0x${string}`,
    abi: chainAbi,
    functionName: "marketCount",
  });

  let mine = 0;
  for (let i = 0n; i < count; i++) {
    const [, creator] = await pub.readContract({
      address: MARKETS as `0x${string}`,
      abi: chainAbi,
      functionName: "markets",
      args: [i],
    });
    if (creator.toLowerCase() === address.toLowerCase()) mine++;
  }
  return mine;
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
