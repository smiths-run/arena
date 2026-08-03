/**
 * One bounded run: observe → propose → policy → execute or record why not.
 *
 * Every run ends in exactly one of four recorded outcomes:
 *   acted     — the policy approved and the chain confirmed
 *   skipped   — the strategist itself chose not to act (a success, not an error)
 *   rejected  — the strategist proposed, the policy engine refused
 *   error     — infrastructure failed; the run says where
 */
import { AGENTS, circle } from "./shared.ts";
import { STRATEGIES } from "./config.ts";
import { evaluate, type Observation } from "./policy.ts";
import { heuristicStrategist, type Strategist } from "./strategist.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";
import * as executor from "./executor.ts";

export async function runOnce(
  agentName: string,
  trigger: string,
  client: ReturnType<typeof circle>,
  strategist: Strategist = heuristicStrategist,
): Promise<void> {
  const agent = AGENTS.find((a) => a.name === agentName);
  const strategy = STRATEGIES[agentName];
  if (!agent || !strategy) throw new Error(`unknown agent ${agentName}`);

  const runId = store.startRun(agentName, trigger);
  const log = (msg: string) => console.log(`[${agentName}#${runId}] ${msg}`);

  try {
    const [markets, recentTrades, balance, blockNow] = await Promise.all([
      obs.fetchMarkets(),
      obs.fetchRecentTrades(),
      obs.walletUsdc(agent.address),
      obs.currentBlock(),
    ]);

    const action = await strategist({
      agentName,
      address: agent.address,
      strategy,
      markets,
      recentTrades,
      blockNow,
    });

    if (action.kind === "skip") {
      store.finishRun(runId, "skipped", { reason: action.reason });
      log(`skip — ${action.reason}`);
      return;
    }

    // The policy engine judges with fresh numbers, not the strategist's claims.
    const observation: Observation = {
      balanceUsdc: balance,
      spent24h: store.spentLast24h(agentName),
      quotedImpactBps: null,
      positionTokens: 0n,
      ownMarketCount: markets.filter((m) => m.creator.toLowerCase() === agent.address.toLowerCase())
        .length,
    };
    if (action.kind === "buy") {
      observation.quotedImpactBps = (await obs.quoteBuy(action.marketId, action.usdcIn)).impactBps;
    } else if (action.kind === "sell") {
      observation.quotedImpactBps = (await obs.quoteSell(action.marketId, action.tokens)).impactBps;
      observation.positionTokens = store.getPosition(agentName, action.marketId)?.tokens ?? 0n;
    }

    const verdict = evaluate(action, strategy, observation);
    if (!verdict.ok) {
      store.finishRun(runId, "rejected", { actionKind: action.kind, reason: verdict.reason });
      log(`policy rejected ${action.kind} — ${verdict.reason}`);
      return;
    }

    const done = await executor.execute(client, agent, action, runId);
    store.finishRun(runId, "acted", {
      actionKind: action.kind,
      reason: summarize(action),
      txHash: done.txHash,
      usdc: done.usdcMoved,
      marketId: done.marketId,
    });
    log(`acted: ${summarize(action)}  tx=${done.txHash}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    store.finishRun(runId, "error", { reason });
    log(`error — ${reason}`);
  }
}

function summarize(action: { kind: string } & Record<string, unknown>): string {
  switch (action.kind) {
    case "buy":
      return `buy ${Number(action.usdcIn) / 1e6} USDC on market ${action.marketId}`;
    case "sell":
      return `sell ${action.tokens} tokens on market ${action.marketId}`;
    case "launch":
      return `launch ${action.symbol} with ${Number(action.initialBuy) / 1e6} USDC`;
    default:
      return action.kind;
  }
}
