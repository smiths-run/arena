/**
 * Per-agent strategy. Structured fields, not prose: the policy engine reads these,
 * and nothing the strategist says can loosen them.
 *
 * Units: USDC amounts in 6-decimal base units, impact in basis points.
 */
export type ActionKind = "buy" | "sell" | "launch";

export interface Strategy {
  /** Actions this agent is permitted to take at all. */
  allowedActions: ActionKind[];
  /** Hard cap per trade, ≤ the contract's own 5 USDC ceiling. */
  maxTradeUsdc: bigint;
  /** Rolling 24h spend cap across all acted buys and launches. */
  dailySpendUsdc: bigint;
  /** The wallet may never be spent below this — gas and exit money. */
  operatingReserveUsdc: bigint;
  /** Agent's own impact ceiling, below the contract's 500 bps hard limit. */
  maxImpactBps: bigint;
  /** Markets this agent must never touch. */
  blockedMarkets: bigint[];
  /** Minimum trades by *other* wallets in the lookback before buying. */
  minExternalTrades: number;
  /** Blocks of lookback for the activity signal. */
  lookbackBlocks: bigint;
  /** Take profit when a position quotes above cost by this many bps. */
  takeProfitBps: bigint;
  /** For launchers: keep at most this many markets of their own. */
  maxOwnMarkets: number;
  /** Initial buy when launching. */
  launchBuyUsdc: bigint;
  /** Seconds between runs; the orchestrator will not wake the agent sooner. */
  cooldownSeconds: number;
}

export const STRATEGIES: Record<string, Strategy> = {
  /** Trader: buys where outsiders are active, takes profit mechanically. */
  anvil: {
    allowedActions: ["buy", "sell"],
    maxTradeUsdc: 2_000_000n,
    dailySpendUsdc: 6_000_000n,
    operatingReserveUsdc: 500_000n,
    maxImpactBps: 450n,
    blockedMarkets: [],
    minExternalTrades: 1,
    lookbackBlocks: 2_000n,
    takeProfitBps: 500n,
    maxOwnMarkets: 0,
    launchBuyUsdc: 0n,
    cooldownSeconds: 60,
  },
  /** Analyst: allowed to buy but demands so much external evidence it rarely does.
   *  Its job is the x402 report desk (M6); refusing trades is expected behaviour. */
  bellows: {
    allowedActions: ["buy"],
    maxTradeUsdc: 1_000_000n,
    dailySpendUsdc: 2_000_000n,
    operatingReserveUsdc: 500_000n,
    maxImpactBps: 200n,
    blockedMarkets: [],
    minExternalTrades: 8,
    lookbackBlocks: 1_000n,
    takeProfitBps: 800n,
    maxOwnMarkets: 0,
    launchBuyUsdc: 0n,
    cooldownSeconds: 90,
  },
  /** Market-maker: launches markets and lives off creator fees from outside flow. */
  tongs: {
    allowedActions: ["launch", "sell"],
    maxTradeUsdc: 1_000_000n,
    dailySpendUsdc: 4_000_000n,
    operatingReserveUsdc: 500_000n,
    maxImpactBps: 450n,
    blockedMarkets: [],
    minExternalTrades: 0,
    lookbackBlocks: 2_000n,
    takeProfitBps: 1_000n,
    maxOwnMarkets: 2,
    launchBuyUsdc: 1_000_000n,
    cooldownSeconds: 120,
  },
};

/** Names tongs draws from when it launches; first unused symbol wins. */
export const LAUNCH_NAMES: Array<{ name: string; symbol: string }> = [
  { name: "Ember", symbol: "EMBER" },
  { name: "Ingot", symbol: "INGOT" },
  { name: "Quench", symbol: "QNCH" },
  { name: "Crucible", symbol: "CRUC" },
];
