/**
 * The proposer. It suggests exactly one action per run — or an explicit skip with
 * its reasoning — and has no power to execute anything: everything it returns goes
 * through the policy engine, and the policy engine does not trust it.
 *
 * Two implementations behind one interface:
 *   - heuristicStrategist: deterministic rules, no external dependency. Always on.
 *   - An LLM strategist plugs in here later (ANTHROPIC_API_KEY-gated) without
 *     touching the policy engine or the executor — that is the point of the seam.
 */
import type { Strategy } from "./config.ts";
import { LAUNCH_NAMES } from "./config.ts";
import type { Action } from "./policy.ts";
import { APPROACH_WEIGHTS, DEFAULT_MANDATE, type Approach } from "./visitor-strategy.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

export interface StrategistInput {
  agentName: string;
  address: `0x${string}`;
  /** The agent's brief — for Smiths agents, the operator's Mandate (or the default). */
  description: string;
  /** Behavioral preference: what this agent's taste favors, never what it may do. */
  approach: Approach;
  strategy: Strategy;
  markets: obs.MarketView[];
  recentTrades: obs.TradeView[];
  blockNow: bigint;
  /** Authoritative own-market count: chain plus in-flight. */
  ownMarkets: number;
}

export type Strategist = (input: StrategistInput) => Promise<Action>;

export const heuristicStrategist: Strategist = async (input) => {
  const { agentName, address, strategy, markets, recentTrades, blockNow, ownMarkets } = input;
  const me = address.toLowerCase();

  // 1) Collect what is already earned before risking anything new. Creator fees
  //    sit as a receivable until claimed; an agent that never claims has income
  //    it can neither spend nor lose, which is not income.
  if (strategy.allowedActions.includes("claim")) {
    for (const fee of await obs.claimableFees(address)) {
      if (fee.amount > 5_000n) {
        return { kind: "claim", marketId: fee.marketId, amount: fee.amount };
      }
    }
  }

  // 2) Exit before entering. Take profit at the strategy's threshold; cut a
  //    position that has fallen past the stop. Both are evaluated on the
  //    liquidation quote, which is what the position would actually fetch.
  if (strategy.allowedActions.includes("sell")) {
    for (const pos of store.positionsOf(agentName)) {
      if (pos.tokens <= 0n) continue;
      const half = pos.tokens / 2n;
      if (half === 0n) continue;

      const { usdcOut: halfOut } = await obs.quoteSell(pos.marketId, half);
      const halfCost = pos.costUsdc / 2n;
      if (halfCost > 0n && halfOut * 10_000n >= halfCost * (10_000n + strategy.takeProfitBps)) {
        return { kind: "sell", marketId: pos.marketId, tokens: half };
      }

      // Stop-loss is judged on the whole position, not half: the question is
      // whether to still be in this market at all.
      const { usdcOut: allOut } = await obs.quoteSell(pos.marketId, pos.tokens);
      if (
        pos.costUsdc > 0n &&
        allOut * 10_000n <= pos.costUsdc * (10_000n - strategy.stopLossBps)
      ) {
        return { kind: "sell", marketId: pos.marketId, tokens: pos.tokens };
      }
    }
  }

  // 3) Launchers: create a market if under the own-market cap and a name is free.
  //    The count comes from the caller, which reads the chain and adds anything
  //    in flight — not from the indexer, which lags. Visitor agents launch their
  //    own token; the house launcher draws from the shared name list.
  if (strategy.allowedActions.includes("launch")) {
    if (ownMarkets < strategy.maxOwnMarkets) {
      const taken = new Set(markets.map((m) => m.symbol));
      const next = (strategy.launchNames ?? LAUNCH_NAMES).find((n) => !taken.has(n.symbol));
      if (next) {
        return { kind: "launch", name: next.name, symbol: next.symbol, initialBuy: strategy.launchBuyUsdc };
      }
      return { kind: "skip", reason: "under own-market cap but every launch name is taken" };
    }
  }

  // 4) Buyers: demand external activity — trades by wallets that are not us, in
  //    the lookback window — then rank candidates by the agent's Approach. The
  //    weights change taste (a Scout favors fresh diversity, Momentum favors
  //    flow, a Contrarian punishes concentration); the minimum-evidence gate
  //    and every hard limit stay exactly where they were.
  if (strategy.allowedActions.includes("buy")) {
    const floor = blockNow - strategy.lookbackBlocks;
    const stats = new Map<
      string,
      { id: bigint; count: number; traders: Map<string, number>; lastBlock: bigint }
    >();
    for (const t of recentTrades) {
      if (t.blockNumber < floor) continue;
      if (t.trader.toLowerCase() === me) continue;
      const key = t.marketId.toString();
      const s = stats.get(key) ?? { id: t.marketId, count: 0, traders: new Map(), lastBlock: 0n };
      s.count += 1;
      const tr = t.trader.toLowerCase();
      s.traders.set(tr, (s.traders.get(tr) ?? 0) + 1);
      if (t.blockNumber > s.lastBlock) s.lastBlock = t.blockNumber;
      stats.set(key, s);
    }

    const w = APPROACH_WEIGHTS[input.approach];
    const tradeCountOf = new Map(markets.map((m) => [m.id.toString(), m.tradeCount]));
    let best: { id: bigint; score: number; count: number } | null = null;
    for (const s of stats.values()) {
      if (strategy.blockedMarkets.includes(s.id)) continue;
      if (s.count < strategy.minExternalTrades) continue;

      const diversity = s.traders.size;
      const topShare = Math.max(...s.traders.values()) / s.count;
      const blocksAgo = Number(blockNow - s.lastBlock);
      const recency = 1 / (1 + blocksAgo / 300);
      // An unknown lifetime total (null, when reading markets straight from the
      // chain) falls back to the flow window rather than counting as zero,
      // which would make every market look brand new to a scout.
      const lifetime = tradeCountOf.get(s.id.toString()) ?? s.count;
      const emerging = 1 / (1 + lifetime / 10);

      const score =
        w.flow * s.count +
        w.recency * recency +
        w.diversity * diversity +
        w.emerging * emerging -
        w.concentration * topShare;

      if (!best || score > best.score) best = { id: s.id, score, count: s.count };
    }

    if (best) {
      const size = strategy.maxTradeUsdc < 1_000_000n ? strategy.maxTradeUsdc : 1_000_000n;
      return { kind: "buy", marketId: best.id, usdcIn: size };
    }

    /**
     * Cold start.
     *
     * "Only enter where others already trade" is the right rule in a running
     * market and a deadlock in an empty one: every agent waits for a first
     * move that no one is allowed to make. Measured here — eleven markets,
     * zero trades in ten thousand blocks, every agent skipping for want of the
     * flow the others were also refusing to create.
     *
     * So when the whole window is empty — not merely thin, empty — one opening
     * position is permitted, at the smallest size the agent trades, in the
     * market its own taste ranks highest. This is not a licence to ignore
     * evidence: the moment any flow exists the gate above applies again, and
     * every hard limit and the policy engine are untouched.
     */
    if (stats.size === 0) {
      const candidates = markets
        .filter((m) => !strategy.blockedMarkets.includes(m.id))
        .filter((m) => m.creator.toLowerCase() !== me);
      if (candidates.length > 0) {
        // With no evidence to rank on, agents must not all pile into the same
        // market — that would be one crowded book, not a market. Each opens
        // where its own name lands, which spreads the first moves and seeds
        // flow in several places at once. Stable per agent, so a restart does
        // not re-roll the choice.
        let h = 0;
        for (const ch of agentName) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const opening = candidates[h % candidates.length];
        const size = strategy.maxTradeUsdc < 500_000n ? strategy.maxTradeUsdc : 500_000n;
        return { kind: "buy", marketId: opening.id, usdcIn: size };
      }
    }

    return {
      kind: "skip",
      reason: `no market had ≥${strategy.minExternalTrades} external trades in the last ${strategy.lookbackBlocks} blocks`,
    };
  }

  return { kind: "skip", reason: "no permitted action produced a candidate" };
};
