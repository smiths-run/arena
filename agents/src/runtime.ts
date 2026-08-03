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
import * as intel from "./intel.ts";

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

    // Paid intelligence, before committing capital. The trader's own signal shows
    // that a market has outside trades; it cannot show whether that flow is one
    // wallet cycling its own market. The analyst can, so anvil buys the answer —
    // and the report is allowed to talk it out of the trade.
    let intelCost: bigint | undefined;
    let intelVerdict: string | undefined;
    if (action.kind === "buy" && strategy.paidIntel.enabled) {
      try {
        await intel.ensureGatewayFunds(client, agent, (purpose, call, idem) =>
          executor.submit(
            client,
            agent,
            purpose,
            call.contractAddress,
            call.abiFunctionSignature,
            call.abiParameters,
            idem,
          ),
        );

        const bought = await intel.buyReport(client, agent, action.marketId, runId);
        intelCost = bought.costUsdc;
        intelVerdict = bought.report.verdict;
        store.spendRecord(agentName, bought.costUsdc);
        log(
          `paid ${Number(bought.costUsdc) / 1e6} USDC for a report on market ${action.marketId}: ` +
            `${bought.report.verdict} (risk ${bought.report.risk}, ` +
            `${bought.report.externalTraders} external trader(s))`,
        );

        if (bought.report.verdict === "unfavourable") {
          store.finishRun(runId, "skipped", {
            reason:
              `bought intelligence on market ${action.marketId} and declined: ` +
              bought.report.findings[0],
            intelCost,
            intelVerdict,
            intelMarket: action.marketId,
          });
          log(`skip on paid advice — ${bought.report.findings[0]}`);
          return;
        }
      } catch (err) {
        // Intelligence is an enhancement, not a dependency: if the desk is down the
        // agent proceeds on its own signal rather than freezing.
        log(`intelligence unavailable, proceeding unaided — ${err instanceof Error ? err.message : err}`);
      }
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
      store.finishRun(runId, "rejected", {
        actionKind: action.kind,
        reason: verdict.reason,
        intelCost,
        intelVerdict,
      });
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
      intelCost,
      intelVerdict,
      intelMarket: intelCost !== undefined && action.kind === "buy" ? action.marketId : undefined,
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
