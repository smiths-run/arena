/**
 * The only path from a policy-approved action to the chain.
 *
 * Reconciliation contract: the pending_tx row is written BEFORE Circle is called.
 * If the worker dies between submit and record, the row's non-terminal state is
 * found at startup and resolved against Circle before the agent may act again —
 * an agent can never repeat a payment because the record of it was lost.
 */
import { parseAbi, decodeEventLog } from "viem";
import type { Action } from "./policy.ts";
import { MARKETS, USDC, circle, idempotencyKey } from "./shared.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

const marketsEventsAbi = parseAbi([
  "event MarketLaunched(uint256 indexed id, address indexed token, address indexed creator, string name, string symbol, uint256 initialBuy)",
  "event Bought(uint256 indexed id, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
  "event Sold(uint256 indexed id, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
]);

const allowanceAbi = parseAbi(["function allowance(address, address) view returns (uint256)"]);

export interface AgentHandle {
  name: string;
  walletId: string;
  address: `0x${string}`;
}

type Circle = ReturnType<typeof circle>;

/** Submit one contract call with the pending-row-first discipline. */
async function submit(
  client: Circle,
  agent: AgentHandle,
  purpose: string,
  contractAddress: string,
  abiFunctionSignature: string,
  abiParameters: unknown[],
  idem: (string | number)[],
): Promise<string> {
  const key = idempotencyKey(...idem);
  store.pendingCreate(key, agent.name, purpose);

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
    ["approve", agent.address, MARKETS, Date.now()],
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
    // Effectively unbounded for this token; the market only pulls what a sell passes.
    ["115792089237316195423570985008687907853269984665640564039457584007913129639935"],
    ["approve-token", agent.address, token, Date.now()],
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
    );
    const { tokens } = await settled(txHash, "Bought");
    store.positionAdd(agent.name, action.marketId, tokens, action.usdcIn);
    store.spendRecord(agent.name, action.usdcIn);
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
    );
    store.positionReduce(agent.name, action.marketId, action.tokens);
    return { txHash, usdcMoved: usdcOut, marketId: action.marketId };
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
  );
  const { marketId, tokens } = await settledLaunch(txHash);
  store.positionAdd(agent.name, marketId, tokens, action.initialBuy);
  store.spendRecord(agent.name, action.initialBuy);
  return { txHash, usdcMoved: action.initialBuy, marketId };
}

/** Read the receipt back for the exact tokens a buy produced. */
async function settled(txHash: string, wanted: "Bought" | "Sold"): Promise<{ tokens: bigint }> {
  const receipt = await obs.pub.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MARKETS.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: marketsEventsAbi, data: log.data, topics: log.topics });
      if (d.eventName === "Bought" && wanted === "Bought") return { tokens: d.args.tokensOut };
      if (d.eventName === "Sold" && wanted === "Sold") return { tokens: d.args.tokensIn };
    } catch {
      /* not one of ours */
    }
  }
  throw new Error(`no ${wanted} event in ${txHash}`);
}

async function settledLaunch(txHash: string): Promise<{ marketId: bigint; tokens: bigint }> {
  const receipt = await obs.pub.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
  let marketId: bigint | null = null;
  let tokens = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MARKETS.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: marketsEventsAbi, data: log.data, topics: log.topics });
      if (d.eventName === "MarketLaunched") marketId = d.args.id;
      if (d.eventName === "Bought") tokens = d.args.tokensOut;
    } catch {
      /* not one of ours */
    }
  }
  if (marketId === null) throw new Error(`no MarketLaunched event in ${txHash}`);
  return { marketId, tokens };
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

/** Startup pass: resolve every non-terminal Circle transaction before agents act. */
export async function reconcile(client: Circle): Promise<number> {
  const rows = store.unresolvedPending();
  for (const row of rows) {
    if (!row.circle_tx_id) {
      // Created but never submitted — the idempotency key guarantees a retry of the
      // same action cannot double-spend, so the row is safely closed as failed.
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
  return rows.length;
}
