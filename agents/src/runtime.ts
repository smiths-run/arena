/**
 * One bounded run: observe → propose → policy → execute or record why not.
 *
 * Every run ends in exactly one of four recorded outcomes:
 *   acted     — the policy approved and the chain confirmed
 *   skipped   — the strategist itself chose not to act (a success, not an error)
 *   rejected  — the strategist proposed, the policy engine refused
 *   error     — infrastructure failed; the run says where
 */
import { circle } from "./shared.ts";
import { resolve } from "./roster.ts";
import { evaluate, type Observation } from "./policy.ts";
import { heuristicStrategist, type Strategist } from "./strategist.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";
import * as executor from "./executor.ts";
import * as intel from "./intel.ts";
import { equityOf, formatEquity } from "./equity.ts";
import { signReceipt, type ReceiptBody } from "./receipt.ts";

/** Snapshot equity at a run's open; a failed read is null, not a crash. */
export async function openRunEquity(
  agentName: string,
  address: `0x${string}`,
  runId: number,
): Promise<Awaited<ReturnType<typeof equityOf>> | null> {
  const opening = await equityOf(agentName, address).catch(() => null);
  if (opening) store.recordEquity(runId, "open", opening.total, opening);
  return opening;
}

/**
 * Close a run: snapshot equity again, then sign the whole record from the
 * agent's own wallet. Shared between autonomous runs and operator-directed
 * ones, so an operator command produces exactly the same attributable,
 * tamper-evident receipt as a run the agent chose for itself.
 */
export async function closeRunWithReceipt(
  client: ReturnType<typeof circle>,
  agent: { name: string; walletId: string; address: `0x${string}` },
  runId: number,
  trigger: string,
  opening: Awaited<ReturnType<typeof equityOf>> | null,
  log: (msg: string) => void,
): Promise<void> {
  const agentName = agent.name;
  const closing = await equityOf(agentName, agent.address).catch(() => null);
  if (closing) {
    store.recordEquity(runId, "close", closing.total, closing);
    if (opening) {
      const delta = closing.total - opening.total;
      const sign = delta >= 0n ? "+" : "";
      log(`net ${sign}${Number(delta) / 1e6} USDC — ${formatEquity(closing)}`);
    }
  }

  // Sign the finished run from the agent's own wallet. A refusal is not an
  // onchain event and this does not pretend otherwise — but it makes the record
  // attributable to the agent and tamper-evident, so a reader checks a signature
  // instead of trusting our database.
  try {
    const row = store.runById(runId) as Record<string, string | null> | undefined;
    if (!row) return;
    const body: ReceiptBody = {
      agent: agent.address,
      agentName,
      runId,
      trigger,
      outcome: String(row.outcome ?? "unknown"),
      actionKind: row.action_kind ?? null,
      reason: row.reason ?? null,
      marketId: row.market_id ?? null,
      txHash: row.tx_hash ?? null,
      usdc: row.usdc ?? null,
      intelCost: row.intel_cost ?? null,
      intelVerdict: row.intel_verdict ?? null,
      equityOpen: row.equity_open ?? null,
      equityClose: row.equity_close ?? null,
      netResult:
        row.equity_open && row.equity_close
          ? (BigInt(row.equity_close) - BigInt(row.equity_open)).toString()
          : null,
      codeVersion: process.env.CODE_VERSION ?? "dev",
    };
    const signed = await signReceipt(client, agent, body);
    store.recordReceipt(runId, signed.detailsHash, signed.signature);
  } catch (err) {
    // An unsigned receipt is a weaker record, not a failed run. Say so rather
    // than losing the run.
    log(`receipt unsigned — ${err instanceof Error ? err.message : err}`);
  }
}

export async function runOnce(
  agentName: string,
  trigger: string,
  client: ReturnType<typeof circle>,
  strategist: Strategist = heuristicStrategist,
  /** Why this run is happening now, when something other than the clock asked. */
  wakeReason?: string,
): Promise<void> {
  const entry = resolve(agentName);
  if (!entry) throw new Error(`unknown agent ${agentName}`);
  const agent = entry;
  const strategy = entry.strategy;

  const runId = store.startRun(agentName, trigger);
  const log = (msg: string) => console.log(`[${agentName}#${runId}] ${msg}`);

  // Equity is snapshotted around every run, including the ones that do nothing.
  // A run that refuses to trade still burns no money and should show a net result
  // of zero — which is only checkable if the zero was measured.
  const opening = await openRunEquity(agentName, agent.address, runId);
  const closeOut = () => closeRunWithReceipt(client, agent, runId, trigger, opening, log);

  try {
    const [markets, recentTrades, balance, blockNow, ownOnChain] = await Promise.all([
      obs.fetchMarkets(),
      obs.fetchRecentTrades(),
      obs.walletUsdc(agent.address),
      obs.currentBlock(),
      obs.ownMarketCountOnChain(agent.address),
    ]);

    // A cap must count confirmed and in-flight together. The chain misses what is
    // still in the mempool; the local ledger has it.
    const ownMarkets = ownOnChain + store.inFlightLaunches(agentName);

    const action = await strategist({
      agentName,
      address: agent.address,
      description: agent.description,
      approach: entry.approach,
      strategy,
      markets,
      recentTrades,
      blockNow,
      ownMarkets,
      wakeReason,
    });

    if (action.kind === "skip") {
      store.finishRun(runId, "skipped", { reason: action.reason });
      log(`skip — ${action.reason}`);
      await closeOut();
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

        const bought = await intel.buyReport(
          client,
          agent,
          action.marketId,
          runId,
          strategy.paidIntel.maxCostUsdc,
        );
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
              `bought intelligence on ${store.marketLabel(action.marketId)} and declined: ` +
              bought.report.findings[0],
            intelCost,
            intelVerdict,
            intelMarket: action.marketId,
          });
          log(`skip on paid advice — ${bought.report.findings[0]}`);
          await closeOut();
          return;
        }
      } catch (err) {
        // Intelligence is an enhancement, not a dependency: if the desk is down the
        // agent proceeds on its own signal rather than freezing.
        log(`intelligence unavailable, proceeding unaided — ${err instanceof Error ? err.message : err}`);
      }
    }

    // The policy engine judges with fresh numbers, not the strategist's claims —
    // and not with a balance that pre-dates our own spending. Funding Gateway and
    // buying a report both move USDC out of the wallet between the observation
    // above and this decision, so the balance is read again here.
    const balanceNow = intelCost === undefined ? balance : await obs.walletUsdc(agent.address);

    const observation: Observation = {
      balanceUsdc: balanceNow,
      spent24h: store.spentLast24h(agentName),
      quotedImpactBps: null,
      positionTokens: 0n,
      ownMarketCount: ownMarkets,
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
      await closeOut();
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
    await closeOut();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    store.finishRun(runId, "error", { reason });
    log(`error — ${reason}`);
    await closeOut();
  }
}

function summarize(action: { kind: string } & Record<string, unknown>): string {
  // A decision reads back to its operator, and a coin has a name — the id is
  // our addressing, not theirs. `marketLabel` falls back to the id whenever the
  // ticker has not been read from the chain yet.
  const where = (id: unknown) => store.marketLabel(String(id));
  switch (action.kind) {
    case "buy":
      return `buy ${Number(action.usdcIn) / 1e6} USDC of ${where(action.marketId)}`;
    case "sell":
      return `sell ${action.tokens} tokens of ${where(action.marketId)}`;
    case "launch":
      return `launch ${action.symbol} with ${Number(action.initialBuy) / 1e6} USDC`;
    case "claim":
      return `claim ${Number(action.amount) / 1e6} USDC of creator fees on ${where(action.marketId)}`;
    default:
      return action.kind;
  }
}
