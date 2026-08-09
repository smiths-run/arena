/**
 * The pure half of Smiths agent creation: what an operator may ask for, and
 * what their agent actually becomes.
 *
 * Three separate dials, three separate jobs:
 *   Approach — what the strategist prefers (Scout/Momentum/Contrarian/Builder)
 *   Risk     — what the policy engine permits (Low/Balanced/High)
 *   Mandate  — what this operator wants, in their own words
 *
 * The Mandate is prose for the model, never policy: whatever it says, the
 * clamps here and the policy engine still bind. Every Smiths agent thinks
 * with the LLM by default — an empty Mandate gets the default one below, it
 * does not silently demote the agent to a rule bot.
 */
import type { Strategy } from "./config.ts";

export const RESERVED_NAMES = new Set([
  "anvil",
  "bellows",
  "tongs",
  "smiths",
  "smiths-run",
  "admin",
  "system",
  "protocol",
  "treasury",
  "null",
  "zero",
]);
export const MAX_USER_AGENTS = 50;

export const APPROACHES = ["scout", "momentum", "contrarian", "builder"] as const;
export type Approach = (typeof APPROACHES)[number];

/** What each Approach asks of the strategist — LLM instruction and fallback weights alike. */
export const APPROACH_GUIDANCE: Record<Approach, string> = {
  scout: [
    "- Pay extra attention to recently launched markets.",
    "- Prefer markets showing new independent participants.",
    "- Explore before committing.",
    "- Do not chase an already exhausted move merely because it is large.",
  ].join("\n"),
  momentum: [
    "- Prefer markets with accelerating recent activity.",
    "- React more readily to sustained external buying.",
    "- Exit positions that lose momentum or become stale.",
  ].join("\n"),
  contrarian: [
    "- Be suspicious of concentrated or one-wallet activity.",
    "- Do not equate popularity with quality.",
    "- Prefer improving diversity over raw volume.",
    "- Skipping a crowded market is a valid win.",
  ].join("\n"),
  builder: [
    "- Prioritize establishing and developing your own market.",
    "- Treat creator-fee income as part of your economics.",
    "- Participate elsewhere when it benefits your own capital.",
  ].join("\n"),
};

/** Scoring weights for the heuristic fallback — Approach changes taste, never limits. */
export const APPROACH_WEIGHTS: Record<
  Approach,
  { flow: number; recency: number; diversity: number; emerging: number; concentration: number }
> = {
  scout: { flow: 0.5, recency: 1, diversity: 2, emerging: 1.5, concentration: 1 },
  momentum: { flow: 2, recency: 1.5, diversity: 0.5, emerging: 0.25, concentration: 0.5 },
  contrarian: { flow: 0.5, recency: 0.5, diversity: 2, emerging: 0.5, concentration: 2.5 },
  builder: { flow: 1, recency: 0.5, diversity: 1, emerging: 0.5, concentration: 1 },
};

export const DEFAULT_MANDATE = [
  "Operate as an autonomous participant in Smiths markets.",
  "Protect your capital.",
  "Explore opportunities that match your Approach.",
  "Launch your own market when appropriate.",
  "Take profits and exit failing positions.",
  "Skipping an action is valid when evidence is weak.",
].join("\n");

export interface VisitorRequest {
  /** The permanent Smiths handle (also accepts legacy `name`). */
  handle?: unknown;
  name?: unknown;
  approach?: unknown;
  /** "low" | "balanced" | "high" (legacy cautious/bold accepted). */
  risk?: unknown;
  /** Free-text Mandate, ≤280 chars (also accepts legacy `mission`). */
  mandate?: unknown;
  mission?: unknown;
}

export interface VisitorPlan {
  handle: string;
  symbol: string;
  approach: Approach;
  mandate: string | null;
  strategy: Strategy;
}

const RISKS = {
  low: { maxTradeUsdc: 500_000n, takeProfitBps: 300n, stopLossBps: 1_000n, minExternalTrades: 2 },
  balanced: { maxTradeUsdc: 1_000_000n, takeProfitBps: 500n, stopLossBps: 1_500n, minExternalTrades: 1 },
  high: { maxTradeUsdc: 2_000_000n, takeProfitBps: 800n, stopLossBps: 2_500n, minExternalTrades: 1 },
} as const;

const RISK_ALIASES: Record<string, keyof typeof RISKS> = {
  low: "low",
  cautious: "low",
  balanced: "balanced",
  high: "high",
  bold: "high",
};

/**
 * Validate and normalize a creation request. Throws with a human-readable
 * message on anything unusable — the message is the API's 400 body. The
 * contract revalidates the handle bytes onchain; this is the polite first gate.
 */
export function planVisitorAgent(req: VisitorRequest, takenSymbols: Set<string> = new Set()): VisitorPlan {
  const raw = typeof req.handle === "string" ? req.handle : req.name;
  if (typeof raw !== "string") throw new Error("handle is required");
  const handle = raw.trim().toLowerCase().replace(/^@/, "");
  if (!/^[a-z][a-z0-9-]{2,15}$/.test(handle)) {
    throw new Error("handle must be 3-16 chars: a-z, 0-9, dashes; starting with a letter");
  }
  if (RESERVED_NAMES.has(handle)) throw new Error(`"@${handle}" is reserved`);

  const approach: Approach = APPROACHES.includes(req.approach as Approach)
    ? (req.approach as Approach)
    : "scout";

  const riskKey = RISK_ALIASES[typeof req.risk === "string" ? req.risk : "balanced"] ?? "balanced";
  const r = RISKS[riskKey];

  // Token symbol: uppercase alphanumerics of the handle, max 8; on collision a
  // deterministic 2-char suffix from the handle keeps symbols distinct. The
  // symbol is a market label — the canonical identity is the handle.
  let symbol = handle.replace(/[^a-z0-9]/g, "").toUpperCase().slice(0, 8);
  if (symbol.length < 2) throw new Error("handle must contain at least 2 letters/digits");
  if (takenSymbols.has(symbol)) {
    let acc = 0;
    for (const ch of handle) acc = (acc * 31 + ch.charCodeAt(0)) >>> 0;
    const suffix = acc.toString(36).toUpperCase().slice(0, 2).padStart(2, "0");
    symbol = `${symbol.slice(0, 6)}${suffix}`;
  }

  let mandate: string | null = null;
  const rawMandate = req.mandate ?? req.mission;
  if (rawMandate !== undefined && rawMandate !== null && rawMandate !== "") {
    if (typeof rawMandate !== "string") throw new Error("mandate must be text");
    mandate = rawMandate.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 280);
    if (mandate.length === 0) mandate = null;
  }

  const strategy: Strategy = {
    allowedActions: ["launch", "buy", "sell", "claim"],
    maxTradeUsdc: r.maxTradeUsdc,
    dailySpendUsdc: 6_000_000n,
    operatingReserveUsdc: 500_000n,
    maxImpactBps: 450n,
    blockedMarkets: [],
    minExternalTrades: r.minExternalTrades,
    lookbackBlocks: 2_000n,
    takeProfitBps: r.takeProfitBps,
    stopLossBps: r.stopLossBps,
    maxOwnMarkets: 1,
    launchBuyUsdc: 1_000_000n,
    cooldownSeconds: 180,
    paidIntel: { enabled: false, maxCostUsdc: 0n },
    // Every Smiths agent thinks by default; the Mandate shapes the objective,
    // it does not switch intelligence on or off. Capped because inference is
    // a cost like any other.
    llm: { enabled: true, maxCallsPerDay: 30 },
    launchNames: [{ name: handle, symbol }],
  };

  return { handle, symbol, approach, mandate, strategy };
}

// Strategy travels to sqlite as JSON; bigints become tagged strings and come
// back as bigints. The tag keeps "2000000" (a bigint) apart from "EMBER".
const TAG = "#bigint:";

export function serializeStrategy(s: Strategy): string {
  return JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? `${TAG}${v}` : v));
}

export function deserializeStrategy(json: string): Strategy {
  return JSON.parse(json, (_k, v) =>
    typeof v === "string" && v.startsWith(TAG) ? BigInt(v.slice(TAG.length)) : v,
  ) as Strategy;
}
