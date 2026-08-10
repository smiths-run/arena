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
  | { kind: "claim"; marketId: bigint; amount: bigint }
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
  /**
   * Markets this agent has created — counted from the chain plus anything still
   * in flight. Never from the indexer: a cap decided against a lagging read is
   * not a cap.
   */
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

/**
 * The two-layer verdict, for operator-directed actions.
 *
 * An operator speaking to their own agent may override the agent's normal
 * policy — its per-trade limit, its daily cap, its blocked markets — because
 * those limits exist to govern the agent's autonomy, and a confirmed, signed
 * operator command is not autonomy. What no signature can override is the
 * layer that protects the system itself: the contract's hard ceilings, the
 * gas the wallet must keep to act at all, selling more than is held, trading
 * without a quote.
 *
 * The autonomous path never sees this function: for the agent acting alone,
 * every conflict is a rejection, exactly as before.
 */
export interface PolicyConflict {
  rule: string;
  detail: string;
}

export type PolicyDecision =
  | { status: "allowed" }
  | { status: "needs_override"; conflicts: PolicyConflict[] }
  | { status: "hard_rejected"; reason: string };

export function decideLayered(
  action: Action,
  strategy: Strategy,
  obs: Observation,
): PolicyDecision {
  if (action.kind === "skip") return { status: "allowed" };

  // ── the hard layer: never crossed, whoever asks ────────────────────────────
  const spend =
    action.kind === "buy" ? action.usdcIn : action.kind === "launch" ? action.initialBuy : 0n;

  if (spend > HARD_MAX_TRADE) {
    return {
      status: "hard_rejected",
      reason: `the market contract caps a single trade at ${Number(HARD_MAX_TRADE) / 1e6} USDC`,
    };
  }
  if (spend > 0n) {
    // The operating reserve stays hard for operator commands too: gas here is
    // USDC, and an agent spent to its last unit cannot even sell its way out.
    const needed = spend + strategy.operatingReserveUsdc + GAS_HEADROOM_USDC;
    if (obs.balanceUsdc < needed) {
      return {
        status: "hard_rejected",
        reason:
          `balance ${Number(obs.balanceUsdc) / 1e6} USDC cannot cover ${Number(spend) / 1e6} ` +
          `plus the ${Number(strategy.operatingReserveUsdc) / 1e6} operating reserve and gas`,
      };
    }
  }
  if (action.kind === "buy" || action.kind === "sell") {
    if (obs.quotedImpactBps === null) {
      return { status: "hard_rejected", reason: "no quote available; refusing to trade blind" };
    }
    if (obs.quotedImpactBps > HARD_IMPACT_BPS) {
      return {
        status: "hard_rejected",
        reason: `price impact ${obs.quotedImpactBps} bps exceeds the contract ceiling ${HARD_IMPACT_BPS} bps`,
      };
    }
  }
  if (action.kind === "sell") {
    if (action.tokens <= 0n) return { status: "hard_rejected", reason: "sell of zero tokens" };
    if (action.tokens > obs.positionTokens) {
      return {
        status: "hard_rejected",
        reason: `sell exceeds the recorded position (${obs.positionTokens} tokens held)`,
      };
    }
  }
  if (action.kind === "launch" && action.initialBuy < 1_000_000n) {
    return {
      status: "hard_rejected",
      reason: "launch below the contract's 1 USDC minimum initial buy",
    };
  }

  // ── the agent-policy layer: overridable with a signed confirmation ─────────
  const conflicts: PolicyConflict[] = [];

  if (!strategy.allowedActions.includes(action.kind)) {
    conflicts.push({
      rule: "allowed actions",
      detail: `"${action.kind}" is outside this agent's normal action set`,
    });
  }
  if (spend > 0n) {
    if (spend > strategy.maxTradeUsdc) {
      conflicts.push({
        rule: "max trade",
        detail: `${Number(spend) / 1e6} USDC exceeds the normal ${Number(strategy.maxTradeUsdc) / 1e6} USDC per-trade limit`,
      });
    }
    if (obs.spent24h + spend > strategy.dailySpendUsdc) {
      conflicts.push({
        rule: "daily spend",
        detail: `${Number(obs.spent24h + spend) / 1e6} USDC would exceed the normal ${Number(strategy.dailySpendUsdc) / 1e6} USDC daily cap`,
      });
    }
  }
  if (
    (action.kind === "buy" || action.kind === "sell") &&
    strategy.blockedMarkets.includes(action.marketId)
  ) {
    conflicts.push({
      rule: "blocked market",
      detail: `market ${action.marketId} is blocked by this agent's configuration`,
    });
  }
  if (
    (action.kind === "buy" || action.kind === "sell") &&
    obs.quotedImpactBps !== null &&
    obs.quotedImpactBps > strategy.maxImpactBps
  ) {
    conflicts.push({
      rule: "price impact",
      detail: `${obs.quotedImpactBps} bps exceeds the agent's normal ${strategy.maxImpactBps} bps limit`,
    });
  }
  if (action.kind === "claim" && action.amount <= GAS_HEADROOM_USDC / 4n) {
    conflicts.push({ rule: "dust claim", detail: "the claim is worth less than its gas" });
  }
  if (action.kind === "launch" && obs.ownMarketCount >= strategy.maxOwnMarkets) {
    conflicts.push({
      rule: "own-market cap",
      detail: `already created ${obs.ownMarketCount} of ${strategy.maxOwnMarkets} markets`,
    });
  }

  return conflicts.length === 0 ? { status: "allowed" } : { status: "needs_override", conflicts };
}

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

  if (action.kind === "claim") {
    // Claiming costs gas. Sweeping dust burns more than it collects, which is a
    // slow way to lose money while looking productive.
    if (action.amount <= GAS_HEADROOM_USDC / 4n) {
      return {
        ok: false,
        reason: `claim of ${action.amount} is not worth the gas it would cost`,
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
