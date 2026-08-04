/**
 * The policy engine. The model proposes; this code disposes.
 *
 * Pure and deterministic: observation in, verdict out. No network, no clock, no
 * randomness — which is what makes it unit-testable and what makes "the agent
 * cannot exceed its limits" a property of the system rather than a hope about
 * the model's behaviour.
 */
import type { Strategy } from "./config.ts";

export type Action =
  | { kind: "buy"; marketId: bigint; usdcIn: bigint }
  | { kind: "sell"; marketId: bigint; tokens: bigint }
  | { kind: "launch"; name: string; symbol: string; initialBuy: bigint }
  | { kind: "skip"; reason: string };

export interface Observation {
  /** Agent's spendable USDC balance, 6-dec base units. */
  balanceUsdc: bigint;
  /** Rolling 24h spend already committed. */
  spent24h: bigint;
  /** Quoted impact for the proposed action, from the chain, in bps. */
  quotedImpactBps: bigint | null;
  /** Tokens the agent holds in the action's market (for sells). */
  positionTokens: bigint;
  /** Markets this agent has created (for launch caps). */
  ownMarketCount: number;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** The contract's own hard ceiling; the policy never exceeds it even if a strategy tries. */
const HARD_IMPACT_BPS = 500n;
const HARD_MAX_TRADE = 5_000_000n;

/**
 * Headroom kept back for the transaction's own gas. Arc denominates gas in USDC,
 * and a measured contract call costs about 0.0018 USDC — so an action that spends
 * the reserve down to the last unit leaves the agent unable to pay for the very
 * transaction that spends it, or for the exit afterwards. Ten times the measured
 * cost is cheap insurance against a fee spike.
 */
const GAS_HEADROOM_USDC = 20_000n; // 0.02 USDC

export function evaluate(action: Action, strategy: Strategy, obs: Observation): Verdict {
  if (action.kind === "skip") return { ok: true };

  if (!strategy.allowedActions.includes(action.kind)) {
    return { ok: false, reason: `action "${action.kind}" is not permitted by strategy` };
  }

  const spend =
    action.kind === "buy" ? action.usdcIn : action.kind === "launch" ? action.initialBuy : 0n;

  if (spend > 0n) {
    const maxTrade =
      strategy.maxTradeUsdc < HARD_MAX_TRADE ? strategy.maxTradeUsdc : HARD_MAX_TRADE;
    if (spend > maxTrade) {
      return { ok: false, reason: `trade ${spend} exceeds max trade ${maxTrade}` };
    }
    if (obs.spent24h + spend > strategy.dailySpendUsdc) {
      return {
        ok: false,
        reason: `daily cap: spent ${obs.spent24h} + ${spend} exceeds ${strategy.dailySpendUsdc}`,
      };
    }
    const needed = spend + strategy.operatingReserveUsdc + GAS_HEADROOM_USDC;
    if (obs.balanceUsdc < needed) {
      return {
        ok: false,
        reason:
          `reserve: balance ${obs.balanceUsdc} cannot cover ${spend} plus reserve ` +
          `${strategy.operatingReserveUsdc} plus ${GAS_HEADROOM_USDC} gas headroom`,
      };
    }
  }

  if (action.kind === "buy" || action.kind === "sell") {
    if (strategy.blockedMarkets.includes(action.marketId)) {
      return { ok: false, reason: `market ${action.marketId} is blocked by strategy` };
    }
    const cap = strategy.maxImpactBps < HARD_IMPACT_BPS ? strategy.maxImpactBps : HARD_IMPACT_BPS;
    if (obs.quotedImpactBps === null) {
      return { ok: false, reason: "no quote available; refusing to trade blind" };
    }
    if (obs.quotedImpactBps > cap) {
      return { ok: false, reason: `impact ${obs.quotedImpactBps} bps exceeds cap ${cap} bps` };
    }
  }

  if (action.kind === "sell") {
    if (action.tokens <= 0n) return { ok: false, reason: "sell of zero tokens" };
    if (action.tokens > obs.positionTokens) {
      return {
        ok: false,
        reason: `sell ${action.tokens} exceeds recorded position ${obs.positionTokens}`,
      };
    }
  }

  if (action.kind === "launch") {
    if (obs.ownMarketCount >= strategy.maxOwnMarkets) {
      return {
        ok: false,
        reason: `own-market cap: already created ${obs.ownMarketCount} of ${strategy.maxOwnMarkets}`,
      };
    }
    if (action.initialBuy < 1_000_000n) {
      return { ok: false, reason: "launch below the contract's 1 USDC minimum initial buy" };
    }
  }

  return { ok: true };
}
