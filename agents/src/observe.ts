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
      "https://rpc.testnet.arc.io",
      "https://rpc.quicknode.testnet.arc.io",
      "https://rpc.blockdaemon.testnet.arc.io",
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
  tradeCount: number;
}

export interface TradeView {
  marketId: bigint;
  trader: `0x${string}`;
  blockNumber: bigint;
}

export async function fetchMarkets(): Promise<MarketView[]> {
  const res = await fetch(`${API}/api/markets?limit=100`);
  if (!res.ok) throw new Error(`indexer /api/markets ${res.status}`);
  const body = (await res.json()) as { markets: any[] };
  return body.markets.map((m) => ({
    id: BigInt(m.id),
    creator: m.creator,
    symbol: m.symbol,
    reserveUsdc: BigInt(m.reserveUsdc),
    tradeCount: m.tradeCount,
  }));
}

export async function fetchRecentTrades(): Promise<TradeView[]> {
  const res = await fetch(`${API}/api/activity?limit=200`);
  if (!res.ok) throw new Error(`indexer /api/activity ${res.status}`);
  const body = (await res.json()) as { activity: any[] };
  return body.activity.map((t) => ({
    marketId: BigInt(t.marketId),
    trader: t.trader,
    blockNumber: BigInt(t.blockNumber),
  }));
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
