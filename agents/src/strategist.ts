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
import * as obs from "./observe.ts";
import * as store from "./store.ts";

export interface StrategistInput {
  agentName: string;
  address: `0x${string}`;
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

  // 4) Buyers: demand external activity — trades by wallets that are not us, in the
  //    lookback window — before putting money in. No signal, no trade.
  if (strategy.allowedActions.includes("buy")) {
    const floor = blockNow - strategy.lookbackBlocks;
    const byMarket = new Map<bigint, number>();
    for (const t of recentTrades) {
      if (t.blockNumber < floor) continue;
      if (t.trader.toLowerCase() === me) continue;
      byMarket.set(t.marketId, (byMarket.get(t.marketId) ?? 0) + 1);
    }

    let best: { id: bigint; count: number } | null = null;
    for (const [id, count] of byMarket) {
      if (strategy.blockedMarkets.includes(id)) continue;
      if (count < strategy.minExternalTrades) continue;
      if (!best || count > best.count) best = { id, count };
    }

    if (best) {
      const size = strategy.maxTradeUsdc < 1_000_000n ? strategy.maxTradeUsdc : 1_000_000n;
      return { kind: "buy", marketId: best.id, usdcIn: size };
    }
    return {
      kind: "skip",
      reason: `no market had ≥${strategy.minExternalTrades} external trades in the last ${strategy.lookbackBlocks} blocks`,
    };
  }

  return { kind: "skip", reason: "no permitted action produced a candidate" };
};
