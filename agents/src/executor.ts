/**
 * The only path from a policy-approved action to the chain.
 *
 * Reconciliation contract: the pending_tx row is written BEFORE Circle is called.
 * If the worker dies between submit and record, the row's non-terminal state is
 * found at startup and resolved against Circle before the agent may act again —
 * an agent can never repeat a payment because the record of it was lost.
 */
import { parseAbi } from "viem";
import type { Action } from "./policy.ts";
import { MARKETS, USDC, circle, idempotencyKey } from "./shared.ts";
import { applyEffects } from "./effects.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

const allowanceAbi = parseAbi(["function allowance(address, address) view returns (uint256)"]);

export interface AgentHandle {
  name: string;
  walletId: string;
  address: `0x${string}`;
}

type Circle = ReturnType<typeof circle>;

/** Submit one contract call with the pending-row-first discipline. */
export async function submit(
  client: Circle,
  agent: AgentHandle,
  purpose: string,
  contractAddress: string,
  abiFunctionSignature: string,
  abiParameters: unknown[],
  idem: (string | number)[],
  runId: number | null = null,
): Promise<string> {
  // Circle takes the ABI signature as a string and the arguments as a loose array,
  // so a wrong arity is only discovered when the transaction fails on their side —
  // which is how a missing `spender` sat undetected in the sell path until the
  // first live sell. Counting them here turns that into an immediate, local error.
  const declared = abiFunctionSignature.slice(
    abiFunctionSignature.indexOf("(") + 1,
    abiFunctionSignature.lastIndexOf(")"),
  );
  const expected = declared.trim() === "" ? 0 : declared.split(",").length;
  if (abiParameters.length !== expected) {
    throw new Error(
      `${purpose}: ${abiFunctionSignature} takes ${expected} argument(s), got ${abiParameters.length}`,
    );
  }

  // The logical key names the *action*; the idempotency key names this *attempt*
  // at it. Circle replays the original outcome for a repeated key, so a retry
  // after a terminal failure needs a new one — derived from how many attempts
  // have already failed, so it stays deterministic across a replayed run.
  const logicalKey = idem.join(":");
  const key = idempotencyKey(logicalKey, store.failedAttempts(logicalKey));
  store.pendingCreate(key, agent.name, purpose, logicalKey, runId);

  const created = await client.createContractExecutionTransaction({
    walletId: agent.walletId,
    contractAddress,
    abiFunctionSignature,
    abiParameters: abiParameters as never[],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: key,
  });
  store.pendingSubmitted(key, created.data!.id!);

  const done = await client.getTransaction({
    id: created.data!.id!,
    waitForState: "COMPLETE",
    pollingInterval: 500,
  });
  const tx = done.data?.transaction;
  store.pendingTerminal(key, tx?.state ?? "FAILED", tx?.txHash ?? null);
  if (tx?.state !== "COMPLETE") {
    throw new Error(`${purpose}: circle tx ended ${tx?.state} (${tx?.errorReason ?? "no reason"})`);
  }

  // Write the local consequences here, inside the same guarded path recovery
  // uses, so a crash after this point cannot leave the ledger behind the chain.
  await applyEffects(key, agent.name, tx.txHash as `0x${string}`);
  return tx.txHash!;
}

async function ensureUsdcAllowance(client: Circle, agent: AgentHandle, need: bigint): Promise<void> {
  const allowance = await obs.pub.readContract({
    address: USDC,
    abi: allowanceAbi,
    functionName: "allowance",
    args: [agent.address, MARKETS as `0x${string}`],
  });
  if (allowance >= need) return;
  await submit(
    client,
    agent,
    "approve-usdc",
    USDC,
    "approve(address,uint256)",
    [MARKETS, "100000000"],
    ["approve", agent.address, MARKETS],
  );
}

async function ensureTokenAllowance(
  client: Circle,
  agent: AgentHandle,
  token: `0x${string}`,
  need: bigint,
): Promise<void> {
  const allowance = await obs.pub.readContract({
    address: token,
    abi: allowanceAbi,
    functionName: "allowance",
    args: [agent.address, MARKETS as `0x${string}`],
  });
  if (allowance >= need) return;
  await submit(
    client,
    agent,
    "approve-token",
    token,
    "approve(address,uint256)",
    // Spender first, then amount — effectively unbounded for this token, since the
    // market only ever pulls what a sell explicitly passes it.
    [MARKETS, "115792089237316195423570985008687907853269984665640564039457584007913129639935"],
    ["approve-token", agent.address, token],
  );
}

export interface Executed {
  txHash: string;
  usdcMoved: bigint;
  marketId: bigint;
}

/** Execute a policy-approved action. Skips must never reach this function. */
export async function execute(
  client: Circle,
  agent: AgentHandle,
  action: Action,
  runId: number,
): Promise<Executed> {
  if (action.kind === "skip") throw new Error("executor received a skip");

  if (action.kind === "buy") {
    const { tokensOut } = await obs.quoteBuy(action.marketId, action.usdcIn);
    await ensureUsdcAllowance(client, agent, action.usdcIn);
    const txHash = await submit(
      client,
      agent,
      "buy",
      MARKETS,
      "buy(uint256,uint256,uint256)",
      [action.marketId.toString(), action.usdcIn.toString(), ((tokensOut * 99n) / 100n).toString()],
      ["buy", agent.address, runId],
      runId,
    );
    return { txHash, usdcMoved: action.usdcIn, marketId: action.marketId };
  }

  if (action.kind === "sell") {
    const market = await marketToken(action.marketId);
    await ensureTokenAllowance(client, agent, market, action.tokens);
    const { usdcOut } = await obs.quoteSell(action.marketId, action.tokens);
    const txHash = await submit(
      client,
      agent,
      "sell",
      MARKETS,
      "sell(uint256,uint256,uint256)",
      [action.marketId.toString(), action.tokens.toString(), ((usdcOut * 99n) / 100n).toString()],
      ["sell", agent.address, runId],
      runId,
    );
    return { txHash, usdcMoved: usdcOut, marketId: action.marketId };
  }

  if (action.kind === "claim") {
    // Permissionless on the contract: anyone may trigger the payout, but it can
    // only ever go to the creator. The agent triggers its own.
    const txHash = await submit(
      client,
      agent,
      "claim",
      MARKETS,
      "claimCreatorFees(uint256)",
      [action.marketId.toString()],
      ["claim", agent.address, action.marketId.toString(), runId],
      runId,
    );
    return { txHash, usdcMoved: action.amount, marketId: action.marketId };
  }

  // launch
  await ensureUsdcAllowance(client, agent, action.initialBuy);
  const txHash = await submit(
    client,
    agent,
    "launch",
    MARKETS,
    "launch(string,string,uint256)",
    [action.name, action.symbol, action.initialBuy.toString()],
    ["launch", agent.address, action.symbol],
    runId,
  );
  const { marketId } = await applyEffects(
    idempotencyKey(["launch", agent.address, action.symbol].join(":"), store.failedAttempts(
      ["launch", agent.address, action.symbol].join(":"),
    )),
    agent.name,
    txHash as `0x${string}`,
  );
  if (marketId === null) throw new Error(`no MarketLaunched event in ${txHash}`);
  return { txHash, usdcMoved: action.initialBuy, marketId };
}

async function marketToken(marketId: bigint): Promise<`0x${string}`> {
  const abi = parseAbi([
    "function markets(uint256) view returns (address token, address creator, uint256 reserveUsdc, uint256 reserveToken, uint256 creatorFees, uint64 createdAtBlock)",
  ]);
  const [token] = await obs.pub.readContract({
    address: MARKETS as `0x${string}`,
    abi,
    functionName: "markets",
    args: [marketId],
  });
  return token;
}

/**
 * Startup pass. Two jobs, and the second is the one that matters.
 *
 * First, close out every Circle transaction still in a non-terminal state. Second
 * — and this is the window a naive reconciler misses — replay the local side
 * effects of anything that reached the chain while nobody was recording. A
 * transaction can be COMPLETE onchain and still be missing from the position and
 * spend ledger, and an agent that wakes up in that state would let the policy
 * engine judge on numbers that are quietly wrong.
 */
export async function reconcile(client: Circle): Promise<{ closed: number; replayed: number }> {
  const rows = store.unresolvedPending();
  for (const row of rows) {
    if (!row.circle_tx_id) {
      // Created but never submitted. A retry gets a fresh attempt number, so
      // closing this as failed cannot cause a double-spend.
      store.pendingTerminal(row.idempotency_key, "FAILED", null);
      continue;
    }
    const res = await client.getTransaction({ id: row.circle_tx_id });
    const tx = res.data?.transaction;
    const state = tx?.state ?? "FAILED";
    if (["COMPLETE", "FAILED", "DENIED", "CANCELLED"].includes(state)) {
      store.pendingTerminal(row.idempotency_key, state, tx?.txHash ?? null);
    }
    // Still in flight → leave it; the orchestrator holds that agent until resolved.
  }

  let replayed = 0;
  for (const row of store.completedButUnapplied()) {
    await applyEffects(row.idempotency_key, row.agent, row.tx_hash as `0x${string}`);
    replayed++;
  }
  return { closed: rows.length, replayed };
}
