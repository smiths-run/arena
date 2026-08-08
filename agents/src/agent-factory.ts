/**
 * Visitor agent creation: prove you own a wallet, and the agent is yours.
 *
 * The creator connects a wallet on the site and signs a one-line message;
 * that signature is the whole identity system. The agent gets its own
 * developer-controlled Circle wallet (nobody ever sees a key), the creator's
 * address is recorded as its owner, and funding is the owner's business: they
 * send USDC from their own wallet to the agent's address — the arena grants
 * nothing. An unfunded agent is not an error; its runs say in public that it
 * is broke until its owner feeds it.
 */
import { verifyMessage } from "viem";
import { USDC, circle } from "./shared.ts";
import {
  MAX_PER_IP_PER_DAY,
  MAX_USER_AGENTS,
  planVisitorAgent,
  serializeStrategy,
  type VisitorRequest,
} from "./visitor-strategy.ts";
import * as store from "./store.ts";

const WALLET_SET_KEY = "visitor_wallet_set_id";

/** The exact text the creator signs; the name binds the signature to one agent. */
export function creationMessage(name: string): string {
  return `Smiths Run: create agent "${name}"`;
}

export interface CreatedAgent {
  name: string;
  symbol: string;
  address: string;
  owner: string;
}

export async function createUserAgent(
  req: VisitorRequest & { owner?: unknown; signature?: unknown },
  ip: string | null,
): Promise<CreatedAgent> {
  const plan = planVisitorAgent(req);

  // Ownership: a wallet signature over the creation message, verified here.
  // No accounts, no passwords — the chain's own identity primitive.
  if (typeof req.owner !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(req.owner)) {
    throw new Error("connect a wallet first — the agent needs an owner");
  }
  if (typeof req.signature !== "string" || !req.signature.startsWith("0x")) {
    throw new Error("missing ownership signature");
  }
  const owner = req.owner.toLowerCase();
  const valid = await verifyMessage({
    address: req.owner as `0x${string}`,
    message: creationMessage(plan.name),
    signature: req.signature as `0x${string}`,
  }).catch(() => false);
  if (!valid) throw new Error("ownership signature does not verify");

  if (store.userAgentByName(plan.name)) throw new Error(`"${plan.name}" already exists`);
  if (store.userAgentCount() >= MAX_USER_AGENTS) {
    throw new Error("the visitor roster is full for now");
  }
  if (store.userAgentsOwnedBy(owner, 24 * 3600 * 1000) >= MAX_PER_IP_PER_DAY) {
    throw new Error(`limit reached: ${MAX_PER_IP_PER_DAY} agents per wallet per day`);
  }
  if (ip && store.userAgentsCreatedBy(ip, 24 * 3600 * 1000) >= MAX_PER_IP_PER_DAY * 2) {
    throw new Error("limit reached for today");
  }

  const client = circle();

  let walletSetId = store.settingGet(WALLET_SET_KEY);
  if (!walletSetId) {
    const ws = await client.createWalletSet({ name: "smiths-run-visitors" });
    walletSetId = ws.data?.walletSet?.id ?? null;
    if (!walletSetId) throw new Error("circle returned no wallet set id");
    store.settingSet(WALLET_SET_KEY, walletSetId);
  }

  const created = await client.createWallets({
    walletSetId,
    blockchains: ["ARC-TESTNET" as never],
    count: 1,
    accountType: "EOA",
  });
  const wallet = created.data?.wallets?.[0];
  if (!wallet?.id || !wallet.address) throw new Error("circle returned no wallet");

  store.userAgentCreate({
    name: plan.name,
    walletId: wallet.id,
    address: wallet.address,
    strategyJson: serializeStrategy(plan.strategy),
    mission: plan.mission,
    owner,
    creatorIp: ip,
  });

  return { name: plan.name, symbol: plan.symbol, address: wallet.address, owner };
}

/**
 * A grant from the ops treasury — not part of the product flow (owners fund
 * their own agents), kept for seeding house demos when TREASURY_SWEEP=1.
 */
export async function treasuryGrant(
  client: ReturnType<typeof circle>,
  to: string,
  amountUsdc: bigint,
): Promise<boolean> {
  const created = await client.createContractExecutionTransaction({
    walletId: process.env.TREASURY_WALLET_ID!,
    contractAddress: USDC,
    abiFunctionSignature: "transfer(address,uint256)",
    abiParameters: [to, amountUsdc.toString()] as never[],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const done = await client.getTransaction({
    id: created.data!.id!,
    waitForState: "COMPLETE",
    pollingInterval: 500,
  });
  return done.data?.transaction?.state === "COMPLETE";
}
