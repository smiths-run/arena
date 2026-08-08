/**
 * The pure half of visitor agent creation: what a visitor may ask for, and the
 * strategy their agent actually gets.
 *
 * A visitor tunes risk inside clamps; they cannot loosen anything the house
 * agents live under. Whatever they type, the resulting strategy is bounded:
 * trade size, daily spend, impact, reserve — all within the same policy-engine
 * regime, all below the contract's own hard ceilings. The LLM stays off for
 * visitor agents (inference is our bill), and their launch name is their own
 * name — an agent launches its token, like the reference product.
 */
import type { Strategy } from "./config.ts";

export const RESERVED_NAMES = new Set(["anvil", "bellows", "tongs"]);
export const MAX_USER_AGENTS = 50;
export const MAX_PER_IP_PER_DAY = 3;

export interface VisitorRequest {
  name?: unknown;
  /** "cautious" | "balanced" | "bold" */
  risk?: unknown;
}

export interface VisitorPlan {
  name: string;
  symbol: string;
  strategy: Strategy;
}

const RISKS = {
  cautious: { maxTradeUsdc: 500_000n, takeProfitBps: 300n, stopLossBps: 1_000n, minExternalTrades: 2 },
  balanced: { maxTradeUsdc: 1_000_000n, takeProfitBps: 500n, stopLossBps: 1_500n, minExternalTrades: 1 },
  bold: { maxTradeUsdc: 2_000_000n, takeProfitBps: 800n, stopLossBps: 2_500n, minExternalTrades: 1 },
} as const;

export type RiskLevel = keyof typeof RISKS;

/**
 * Validate and normalize a creation request. Throws with a human-readable
 * message on anything unusable — the message is the API's 400 body.
 */
export function planVisitorAgent(req: VisitorRequest): VisitorPlan {
  if (typeof req.name !== "string") throw new Error("name is required");
  const name = req.name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,15}$/.test(name)) {
    throw new Error("name must be 3-16 chars: lowercase letters, digits, dashes");
  }
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is taken by a house agent`);

  const risk = (typeof req.risk === "string" ? req.risk : "balanced") as RiskLevel;
  const r = RISKS[risk] ?? RISKS.balanced;

  // Symbol: the name's letters/digits, uppercased, max 8 — the agent's own token.
  const symbol = name.replace(/[^a-z0-9]/g, "").toUpperCase().slice(0, 8);
  if (symbol.length < 2) throw new Error("name must contain at least 2 letters/digits");

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
    llm: { enabled: false, maxCallsPerDay: 0 },
    launchNames: [{ name, symbol }],
  };

  return { name, symbol, strategy };
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
