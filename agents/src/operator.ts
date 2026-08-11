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
import {
  GAS_HEADROOM_USDC,
  decideLayered,
  type Action,
  type Observation,
  type PolicyConflict,
} from "./policy.ts";
import { closeRunWithReceipt, openRunEquity } from "./runtime.ts";
import * as executor from "./executor.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

export function describeAction(action: Action): string {
  // This sentence is what the operator signs, so it names the coin the way
  // they asked for it; the id remains the fallback until the ticker is known.
  const where = (id: bigint) => store.marketLabel(id);
  switch (action.kind) {
    case "buy":
      return `buy ${Number(action.usdcIn) / 1e6} USDC of ${where(action.marketId)}`;
    case "sell":
      return `sell ${action.tokens} tokens of ${where(action.marketId)}`;
    case "launch":
      return `launch ${action.symbol} ("${action.name}") with a ${Number(action.initialBuy) / 1e6} USDC initial buy`;
    case "claim":
      return `claim ${Number(action.amount) / 1e6} USDC of creator fees on ${where(action.marketId)}`;
    case "withdraw":
      return `send ${Number(action.amount) / 1e6} USDC to your wallet ${action.to}`;
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
  const note =
    acknowledged.length > 0
      ? ` [operator override, confirmed #${confirmationId}: ${acknowledged
          .map((c) => c.rule)
          .join(", ")}]`
      : ` [operator-directed, confirmed #${confirmationId}]`;
  return executeDirected(client, entry, action, { acknowledged, note, trigger: "operator" });
}

/**
 * Run one already-decided action through policy, execution and a receipt.
 *
 * Two things direct an agent rather than proposing to it: an operator's signed
 * command, and a trigger the operator confirmed earlier. They differ in what
 * consent looks like and in what the receipt should say, and in nothing else —
 * so they share this, and money moves in exactly one place.
 *
 * `acknowledged` are the agent-policy conflicts that consent already covers.
 * They are recorded rather than re-blocked; anything that appeared since then
 * blocks, because a consent given five minutes ago was not given to it.
 */
export async function executeDirected(
  client: ReturnType<typeof circle>,
  entry: RosterEntry,
  action: Action,
  opts: { acknowledged: PolicyConflict[]; note: string; trigger: string },
): Promise<OperatorResult> {
  const { acknowledged, note: overrideNote, trigger } = opts;
  const runId = store.startRun(entry.name, trigger);
  const log = (msg: string) => console.log(`[${entry.name}#${runId}] ${msg}`);
  const opening = await openRunEquity(entry.name, entry.address, runId);

  try {
    const observation = await observeFor(entry, action);
    const decision = decideLayered(action, entry.strategy, observation);

    if (decision.status === "hard_rejected") {
      store.finishRun(runId, "rejected", {
        actionKind: action.kind,
        reason: `hard guardrail: ${decision.reason}${overrideNote}`,
      });
      log(`hard-rejected ${trigger} action — ${decision.reason}`);
      await closeRunWithReceipt(client, entry, runId, trigger, opening, log);
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
        await closeRunWithReceipt(client, entry, runId, trigger, opening, log);
        return { outcome: "rejected", runId, detail };
      }
    }

    const done = await executor.execute(client, entry, action, runId);
    store.finishRun(runId, "acted", {
      actionKind: action.kind,
      reason: describeAction(action) + overrideNote,
      txHash: done.txHash,
      usdc: done.usdcMoved,
      marketId: done.marketId ?? undefined,
    });
    log(`${trigger} action executed: ${describeAction(action)}  tx=${done.txHash}`);
    await closeRunWithReceipt(client, entry, runId, trigger, opening, log);
    return { outcome: "acted", runId, detail: describeAction(action), txHash: done.txHash };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    store.finishRun(runId, "error", { reason: reason + overrideNote });
    log(`${trigger} action failed — ${reason}`);
    await closeRunWithReceipt(client, entry, runId, trigger, opening, log);
    return { outcome: "error", runId, detail: reason };
  }
}

/**
 * Send the operator's own capital back to the wallet it came from.
 *
 * Three things make this different from every other action here, and each is
 * deliberate.
 *
 * The destination is never asked for. It is the agent's owner as the ledger
 * knows them, and the signed message names it in full — a withdrawal that took
 * its address from the request would turn any weakness in authorization into a
 * drain, and a truncated address in a signed message is not an address at all.
 *
 * No equity is snapshotted at the open. Net result is measured as equity before
 * and after a run precisely so that no cost can hide inside one; money the
 * operator takes out is not a cost and not a loss, and recording it as one
 * would put a large false loss on the agent's public record. The run is still
 * signed and still public — it simply does not pretend to be performance.
 *
 * It is allowed in any state. An agent that is paused, unfunded or in error
 * still holds someone's money, and a state machine must never be the reason
 * they cannot get it back.
 */
export async function executeWithdrawal(
  client: ReturnType<typeof circle>,
  entry: RosterEntry,
  amount: bigint,
): Promise<OperatorResult> {
  const to = entry.owner;
  if (!to) {
    return { outcome: "rejected", runId: 0, detail: "this agent has no operator to pay out to" };
  }
  if (store.unresolvedPending().some((p) => p.agent === entry.name)) {
    return {
      outcome: "rejected",
      runId: 0,
      detail: "a transaction is still in flight — the balance is not settled yet, try again in a moment",
    };
  }
  // One wallet, one thing at a time: the scheduler and the trigger lane hold
  // this same lease, so a withdrawal cannot race a trade onto the same nonce.
  if (!store.leaseAcquire(entry.name, "withdraw", 120_000)) {
    return { outcome: "rejected", runId: 0, detail: "the agent is mid-run — try again in a moment" };
  }

  const action: Action = { kind: "withdraw", amount, to };
  const runId = store.startRun(entry.name, "withdraw");
  const log = (msg: string) => console.log(`[${entry.name}#${runId}] ${msg}`);

  try {
    const observation = await observeFor(entry, action);
    const decision = decideLayered(action, entry.strategy, observation);
    if (decision.status === "hard_rejected") {
      store.finishRun(runId, "rejected", {
        actionKind: "withdraw",
        reason: `hard guardrail: ${decision.reason} [operator withdrawal]`,
      });
      log(`withdrawal refused — ${decision.reason}`);
      await closeRunWithReceipt(client, entry, runId, "withdraw", null, log);
      return { outcome: "rejected", runId, detail: decision.reason };
    }

    const done = await executor.execute(client, entry, action, runId);
    store.finishRun(runId, "acted", {
      actionKind: "withdraw",
      reason: `${describeAction(action)} [operator withdrawal]`,
      txHash: done.txHash,
      usdc: done.usdcMoved,
    });
    log(`withdrew ${Number(amount) / 1e6} USDC to ${to}  tx=${done.txHash}`);
    await closeRunWithReceipt(client, entry, runId, "withdraw", null, log);
    return { outcome: "acted", runId, detail: describeAction(action), txHash: done.txHash };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    store.finishRun(runId, "error", {
      // Name the attempt even when it failed: "the withdrawal errored" is an
      // answer, "something errored" is not.
      actionKind: "withdraw",
      usdc: amount,
      reason: `${reason} [operator withdrawal]`,
    });
    log(`withdrawal failed — ${reason}`);
    await closeRunWithReceipt(client, entry, runId, "withdraw", null, log);
    return { outcome: "error", runId, detail: reason };
  } finally {
    store.leaseRelease(entry.name, "withdraw");
  }
}

/** The most that may leave a wallet: everything except the gas it needs to act. */
export function withdrawable(balanceUsdc: bigint): bigint {
  return balanceUsdc > GAS_HEADROOM_USDC ? balanceUsdc - GAS_HEADROOM_USDC : 0n;
}
