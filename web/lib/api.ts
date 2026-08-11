/**
 * Server-side data access.
 *
 * Everything the site shows now comes from the agent service, which reads it
 * from the chain. The indexer is no longer a dependency: it could not finish a
 * backfill against Arc's public endpoints, and while it was the source the
 * front page showed one market out of eleven and every other detail page
 * answered with a 500. The browser reaches the same routes through the
 * same-origin /api rewrites for live refresh.
 */
const RECEIPTS = process.env.RECEIPTS_URL ?? "http://localhost:42070";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export interface Run {
  id: number;
  agent: string;
  trigger_kind: string;
  started_at: number;
  finished_at: number | null;
  outcome: "acted" | "skipped" | "rejected" | "error" | null;
  action_kind: string | null;
  reason: string | null;
  tx_hash: string | null;
  usdc: string | null;
  market_id: string | null;
  intel_cost: string | null;
  intel_verdict: string | null;
  intel_market: string | null;
  equity_open: string | null;
  equity_close: string | null;
  receipt_signature: string | null;
}

export interface RosterAgent {
  name: string;
  address: string;
  kind: "house" | "visitor";
  /** ERC-8004 id, once the agent has registered itself on Arc. */
  agentId: string | null;
  symbol: string | null;
  mission?: string | null;
  owner?: string | null;
  walletUsdc: string | null;
  spent24h: string;
  outcomes: Record<string, number>;
  positions: Array<{ marketId: string; tokens: string; costUsdc: string }>;
  intelBoughtCount: number;
  intelSpent: string;
  intelSoldCount: number;
  intelEarned: string;
  netResult: string;
  /** Unix ms of this agent's last run, or 0 if it has never run. */
  lastRunAt?: number;
}

export interface IntelPurchase {
  id: number;
  run_id: number | null;
  buyer: string;
  market_id: string;
  cost_usdc: string;
  verdict: string | null;
  settlement_ref: string | null;
  at: number;
}

export interface IntelSale {
  id: number;
  seller: string;
  payer: string;
  market_id: string;
  amount_usdc: string;
  settlement_ref: string | null;
  at: number;
}

export interface IntelLedger {
  purchases: IntelPurchase[];
  sales: IntelSale[];
  totals: {
    bought: Array<{ buyer: string; count: number; total: string }>;
    sold: Array<{ seller: string; count: number; total: string }>;
  };
}

export interface RunOverview {
  exists: boolean;
  agent?: {
    handle: string;
    agentId: string | null;
    wallet: string;
    approach: string;
    risk: string;
    mandate: string | null;
    state: string;
    identityTx: string | null;
    handleTx: string | null;
  };
  economics?: {
    equity: string | null;
    cash: string | null;
    netResult: string;
    positionCount: number;
    claimableFees: string | null;
  };
  positions?: Array<{
    marketId: string;
    /** The coin's ticker, or null until the chain read for it has landed. */
    symbol: string | null;
    tokens: string;
    costUsdc: string;
    valueUsdc: string | null;
  }>;
  recentDecisions?: Array<{
    id: number;
    at: number;
    outcome: string | null;
    action: string | null;
    marketId: string | null;
    symbol: string | null;
    usdc: string | null;
    reason: string;
    txHash: string | null;
    signed: boolean;
    netResult: string | null;
  }>;
}

export interface HandleCheck {
  handle: string;
  valid: boolean;
  available: boolean;
  reserved: boolean;
}

export interface MyAgent {
  handle: string;
  state: string;
  approach: string;
  agentId: string | null;
  wallet: string;
  cashUsdc: string | null;
  netResult: string;
  positions: number;
}

/** The chain's own answer about what exists, from the agent service's cache. */
export interface ChainMarket {
  id: string;
  symbol: string;
  name: string;
  token: string;
  creator: string;
  /** The creator's handle when the wallet is an agent we know; null otherwise. */
  creatorHandle: string | null;
  reserveUsdc: string;
  recentTrades: number;
  /** Lifetime totals, or null where the history walk has not reached yet. */
  volumeUsdc: string | null;
  tradeCount: number | null;
}

export interface HistoryStatus {
  cursor: string;
  head: string;
  caughtUp: boolean;
}

export interface ChainTrade {
  marketId: string;
  symbol: string;
  trader: string;
  traderHandle: string | null;
  side: "buy" | "sell";
  usdc: string;
  impactBps: string;
  txHash: string;
  logIndex: number;
  blockNumber: string;
}

export interface ChatMessage {
  id: number;
  role: "operator" | "agent";
  content: string;
  created_at: number;
}

export interface PendingConfirmation {
  id: number;
  type: string;
  summary: string;
  conflicts: Array<{ rule: string; detail: string }>;
  expiresAt: number;
  hash: string;
}

export interface AgentRule {
  id: number;
  text: string;
  enabled: boolean;
}

export const api = {
  chain: () =>
    get<{ markets: ChainMarket[]; recentTrades: ChainTrade[]; history: HistoryStatus }>(
      `${RECEIPTS}/markets`,
    ),
  roster: () => get<{ agents: RosterAgent[] }>(`${RECEIPTS}/agents`),
  runs: (limit = 60) => get<{ runs: Run[] }>(`${RECEIPTS}/runs?limit=${limit}`),
  intel: () => get<IntelLedger>(`${RECEIPTS}/intel`),
  netResult: () =>
    get<{ agents: Array<{ agent: string; runs: number; net: string }> }>(`${RECEIPTS}/net-result`),
};

// ── formatting ──────────────────────────────────────────────────────────────

/** 6-decimal base units -> "1.24" USDC, trimmed. */
export function usdc(base: string | bigint | null | undefined): string {
  if (base === null || base === undefined) return "0";
  const n = BigInt(base);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * USDC for reading rather than for auditing: two decimals, grouped thousands.
 * Curve reserves carry six decimals of real precision, and printing all of
 * them turned a headline number into 1394.509684 and pushed a counter off the
 * page. Exact figures belong on the surfaces that settle money.
 */
export function usdcRounded(base: string | bigint | null | undefined): string {
  if (base === null || base === undefined) return "0";
  const n = Number(BigInt(base)) / 1e6;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Signed 6-decimal amount, with the sign kept — a net result of zero is meaningful. */
export function signedUsdc(base: string | null | undefined): string {
  if (base === null || base === undefined) return "0";
  const n = BigInt(base);
  const sign = n < 0n ? "-" : "+";
  return sign + usdc(n < 0n ? -n : n);
}

export function bps(v: string): string {
  return `${(Number(v) / 100).toFixed(2)}%`;
}

export const EXPLORER = "https://testnet.arcscan.app";

/** Our three hosted agents, for labeling addresses the reader will see often. */
export const KNOWN: Record<string, string> = {
  "0xe820612807a52d714ddd4e35756f33cceb79d734": "anvil",
  "0x6af5f2514b9d5c6cafaa5cea68200ac7480d1eb5": "bellows",
  "0x12aa4322a313d33815ba7fb4145066a79eef26fd": "tongs",
};

export function who(addr: string): string {
  return KNOWN[addr.toLowerCase()] ?? short(addr);
}

/**
 * How to name whoever acted.
 *
 * The service resolves a wallet to a handle when it belongs to an agent, and
 * the page prints exactly that: no guessing from a ticker, and no pretending a
 * stranger's wallet is one of ours. A wallet with no handle stays an address.
 */
export function actorName(handle: string | null | undefined, wallet: string): string {
  return handle ? `@${handle}` : who(wallet);
}
