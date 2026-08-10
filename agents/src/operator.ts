/**
 * Operator-directed actions: what happens after the operator has signed.
 *
 * A confirmed command skips the strategist — the operator has already decided
 * — but skips nothing else. It takes the same fresh observation the autonomous
 * path takes, faces the two-layer policy (agent policy acknowledged by the
 * signature, hard guardrails acknowledged by no one), and executes through the
 * same executor that writes a pending_tx row before any Circle call is made.
 * The run lands in the same ledger with trigger "operator" and is signed by
 * the agent's wallet like every other, with the override spelled out in the
 * reason so the receipt tells the whole story.
 */
import { circle } from "./shared.ts";
import type { RosterEntry } from "./roster.ts";
import { decideLayered, type Action, type Observation, type PolicyConflict } from "./policy.ts";
import { closeRunWithReceipt, openRunEquity } from "./runtime.ts";
import * as executor from "./executor.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

export function describeAction(action: Action): string {
  switch (action.kind) {
    case "buy":
      return `buy ${Number(action.usdcIn) / 1e6} USDC on market ${action.marketId}`;
    case "sell":
      return `sell ${action.tokens} tokens on market ${action.marketId}`;
    case "launch":
      return `launch ${action.symbol} ("${action.name}") with a ${Number(action.initialBuy) / 1e6} USDC initial buy`;
    case "claim":
      return `claim ${Number(action.amount) / 1e6} USDC of creator fees on market ${action.marketId}`;
    case "skip":
      return "do nothing";
  }
}

/** Fresh numbers for the layered check — same reads the autonomous path uses. */
export async function observeFor(entry: RosterEntry, action: Action): Promise<Observation> {
  const observation: Observation = {
    balanceUsdc: await obs.walletUsdc(entry.address),
    spent24h: store.spentLast24h(entry.name),
    quotedImpactBps: null,
    positionTokens: 0n,
    ownMarketCount:
      (await obs.ownMarketCountOnChain(entry.address)) + store.inFlightLaunches(entry.name),
  };
  if (action.kind === "buy") {
    observation.quotedImpactBps = (await obs.quoteBuy(action.marketId, action.usdcIn)).impactBps;
  } else if (action.kind === "sell") {
    observation.quotedImpactBps = (await obs.quoteSell(action.marketId, action.tokens)).impactBps;
    observation.positionTokens = store.getPosition(entry.name, action.marketId)?.tokens ?? 0n;
  }
  return observation;
}

export interface OperatorResult {
  outcome: "acted" | "rejected" | "error";
  runId: number;
  detail: string;
  txHash?: string;
}

/**
 * Execute a signed operator command. `acknowledged` are the agent-policy
 * conflicts the operator confirmed; they are recorded, not re-blocked. Hard
 * guardrails are re-checked with fresh numbers regardless — a signature five
 * minutes old proves consent, not that the balance still covers the trade.
 */
export async function executeOperatorAction(
  client: ReturnType<typeof circle>,
  entry: RosterEntry,
  action: Action,
  acknowledged: PolicyConflict[],
  confirmationId: number,
): Promise<OperatorResult> {
  const runId = store.startRun(entry.name, "operator");
  const log = (msg: string) => console.log(`[${entry.name}#${runId}] ${msg}`);
  const opening = await openRunEquity(entry.name, entry.address, runId);

  const overrideNote =
    acknowledged.length > 0
      ? ` [operator override, confirmed #${confirmationId}: ${acknowledged
          .map((c) => c.rule)
          .join(", ")}]`
      : ` [operator-directed, confirmed #${confirmationId}]`;

  try {
    const observation = await observeFor(entry, action);
    const decision = decideLayered(action, entry.strategy, observation);

    if (decision.status === "hard_rejected") {
      store.finishRun(runId, "rejected", {
        actionKind: action.kind,
        reason: `hard guardrail: ${decision.reason}${overrideNote}`,
      });
      log(`hard-rejected operator command — ${decision.reason}`);
      await closeRunWithReceipt(client, entry, runId, "operator", opening, log);
      return { outcome: "rejected", runId, detail: decision.reason };
    }

    if (decision.status === "needs_override") {
      // Conflicts must have been acknowledged in the signed confirmation. A
      // conflict that appeared only now (the market moved between proposal and
      // signature) was never consented to, so it blocks.
      const known = new Set(acknowledged.map((c) => c.rule));
      const fresh = decision.conflicts.filter((c) => !known.has(c.rule));
      if (fresh.length > 0) {
        const detail = `new conflict since you confirmed: ${fresh
          .map((c) => c.detail)
          .join("; ")} — propose again`;
        store.finishRun(runId, "rejected", {
          actionKind: action.kind,
          reason: detail + overrideNote,
        });
        log(`rejected — ${detail}`);
        await closeRunWithReceipt(client, entry, runId, "operator", opening, log);
        return { outcome: "rejected", runId, detail };
      }
    }

    const done = await executor.execute(client, entry, action, runId);
    store.finishRun(runId, "acted", {
      actionKind: action.kind,
      reason: describeAction(action) + overrideNote,
      txHash: done.txHash,
      usdc: done.usdcMoved,
      marketId: done.marketId,
    });
    log(`operator action executed: ${describeAction(action)}  tx=${done.txHash}`);
    await closeRunWithReceipt(client, entry, runId, "operator", opening, log);
    return { outcome: "acted", runId, detail: describeAction(action), txHash: done.txHash };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    store.finishRun(runId, "error", { reason: reason + overrideNote });
    log(`operator action failed — ${reason}`);
    await closeRunWithReceipt(client, entry, runId, "operator", opening, log);
    return { outcome: "error", runId, detail: reason };
  }
}
