/**
 * Per-agent strategy. Structured fields, not prose: the policy engine reads these,
 * and nothing the strategist says can loosen them.
 *
 * Units: USDC amounts in 6-decimal base units, impact in basis points.
 */
export type ActionKind = "buy" | "sell" | "launch" | "claim";

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
  /**
   * Cut a position that has fallen this far below cost, in bps.
   *
   * Its absence was a real gap: a strategy with a take-profit and no stop-loss
   * has unbounded downside on any single position. Set generously — a fresh
   * position is always underwater by the round trip's two fees (~200 bps), and
   * cutting on that alone would just realise the spread.
   */
  stopLossBps: bigint;
  /** For launchers: keep at most this many markets of their own. */
  maxOwnMarkets: number;
  /** Initial buy when launching. */
  launchBuyUsdc: bigint;
  /** Seconds between runs; the orchestrator will not wake the agent sooner. */
  cooldownSeconds: number;
  /**
   * Buy a report from the analyst desk before committing to a buy. The trader's
   * own signal cannot distinguish genuine outside interest from one wallet
   * cycling a market; the report can, so it is worth paying for.
   */
  paidIntel: { enabled: boolean; maxCostUsdc: bigint };
  /**
   * Let an LLM propose this agent's actions (ANTHROPIC_API_KEY-gated). The
   * model has exactly the heuristic's authority — none; every proposal still
   * passes the policy engine. Inference is a cost, so it is capped like one:
   * past maxCallsPerDay the agent runs on the heuristic until the day rolls.
   */
  llm: { enabled: boolean; maxCallsPerDay: number };
}

export const STRATEGIES: Record<string, Strategy> = {
  /** Trader: buys where outsiders are active, takes profit mechanically. */
  anvil: {
    allowedActions: ["buy", "sell", "claim"],
    maxTradeUsdc: 2_000_000n,
    dailySpendUsdc: 6_000_000n,
    operatingReserveUsdc: 500_000n,
    maxImpactBps: 450n,
    blockedMarkets: [],
    minExternalTrades: 1,
    lookbackBlocks: 2_000n,
    takeProfitBps: 500n,
    stopLossBps: 1_500n,
    maxOwnMarkets: 0,
    launchBuyUsdc: 0n,
    cooldownSeconds: 60,
    paidIntel: { enabled: true, maxCostUsdc: 10_000n },
    llm: { enabled: true, maxCallsPerDay: 150 },
  },
  /** Analyst: allowed to buy but demands so much external evidence it rarely does.
   *  Its job is the x402 report desk (M6); refusing trades is expected behaviour. */
  bellows: {
    allowedActions: ["buy", "claim"],
    maxTradeUsdc: 1_000_000n,
    dailySpendUsdc: 2_000_000n,
    operatingReserveUsdc: 500_000n,
    maxImpactBps: 200n,
    blockedMarkets: [],
    minExternalTrades: 8,
    lookbackBlocks: 1_000n,
    takeProfitBps: 800n,
    stopLossBps: 1_500n,
    maxOwnMarkets: 0,
    launchBuyUsdc: 0n,
    cooldownSeconds: 90,
    paidIntel: { enabled: false, maxCostUsdc: 0n },
    llm: { enabled: false, maxCallsPerDay: 0 },
  },
  /** Market-maker: launches markets and lives off creator fees from outside flow. */
  tongs: {
    allowedActions: ["launch", "sell", "claim"],
    maxTradeUsdc: 1_000_000n,
    dailySpendUsdc: 4_000_000n,
    operatingReserveUsdc: 500_000n,
    maxImpactBps: 450n,
    blockedMarkets: [],
    minExternalTrades: 0,
    lookbackBlocks: 2_000n,
    takeProfitBps: 300n,
    stopLossBps: 1_500n,
    maxOwnMarkets: 3,
    launchBuyUsdc: 1_000_000n,
    cooldownSeconds: 120,
    paidIntel: { enabled: false, maxCostUsdc: 0n },
    llm: { enabled: false, maxCallsPerDay: 0 },
  },
};

/** Names tongs draws from when it launches; first unused symbol wins. */
export const LAUNCH_NAMES: Array<{ name: string; symbol: string }> = [
  { name: "Ember", symbol: "EMBER" },
  { name: "Ingot", symbol: "INGOT" },
  { name: "Quench", symbol: "QNCH" },
  { name: "Crucible", symbol: "CRUC" },
];
