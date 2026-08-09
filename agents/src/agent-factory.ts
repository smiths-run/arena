/**
 * Smiths agent creation: prove you own a wallet, and the agent is yours —
 * exactly one per operator.
 *
 * The operator signs a one-line message; that signature is the identity
 * system. The agent gets its own developer-controlled Circle wallet and is
 * born AWAITING_FUNDING: the operator feeds it from their own wallet, and
 * the activation sweep registers its ERC-8004 identity and claims its
 * permanent Smiths handle onchain before it may act. The arena grants
 * nothing and holds no keys anyone can see.
 */
import { verifyMessage } from "viem";
import { circle } from "./shared.ts";
import { handleAvailable } from "./identity.ts";
import {
  MAX_USER_AGENTS,
  planVisitorAgent,
  serializeStrategy,
  type VisitorRequest,
} from "./visitor-strategy.ts";
import * as store from "./store.ts";

const WALLET_SET_KEY = "visitor_wallet_set_id";

/** The exact text the operator signs; the handle binds the signature to one agent. */
export function creationMessage(handle: string): string {
  return `Smiths Run: create agent "${handle}"`;
}

export interface CreatedAgent {
  handle: string;
  symbol: string;
  agentWallet: string;
  owner: string;
  state: string;
}

export async function createUserAgent(
  req: VisitorRequest & { owner?: unknown; signature?: unknown },
  ip: string | null,
): Promise<CreatedAgent> {
  const taken = new Set(
    store.userAgents().flatMap((r) => {
      try {
        const s = JSON.parse(r.strategy) as { launchNames?: Array<{ symbol: string }> };
        return s.launchNames?.map((l) => l.symbol) ?? [];
      } catch {
        return [];
      }
    }),
  );
  const plan = planVisitorAgent(req, taken);

  if (typeof req.owner !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(req.owner)) {
    throw new Error("connect a wallet first — the agent needs an operator");
  }
  if (typeof req.signature !== "string" || !req.signature.startsWith("0x")) {
    throw new Error("missing ownership signature");
  }
  const owner = req.owner.toLowerCase();
  const valid = await verifyMessage({
    address: req.owner as `0x${string}`,
    message: creationMessage(plan.handle),
    signature: req.signature as `0x${string}`,
  }).catch(() => false);
  if (!valid) throw new Error("ownership signature does not verify");

  // One operator wallet, one Smiths agent.
  const existing = store.userAgentByOwner(owner);
  if (existing) {
    throw new Error(`this wallet already controls @${existing.name}`);
  }

  if (store.userAgentByName(plan.handle)) throw new Error(`"@${plan.handle}" already exists`);
  if (!(await handleAvailable(plan.handle).catch(() => true))) {
    throw new Error(`"@${plan.handle}" is taken onchain`);
  }
  if (store.userAgentCount() >= MAX_USER_AGENTS) {
    throw new Error("the roster is full for now");
  }
  if (ip && store.userAgentsCreatedBy(ip, 3600 * 1000) >= 6) {
    throw new Error("too many creations from this network — try later");
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
    name: plan.handle,
    walletId: wallet.id,
    address: wallet.address,
    strategyJson: serializeStrategy(plan.strategy),
    mission: plan.mandate,
    owner,
    approach: plan.approach,
    state: "awaiting_funding",
    creatorIp: ip,
  });

  return {
    handle: plan.handle,
    symbol: plan.symbol,
    agentWallet: wallet.address,
    owner,
    state: "awaiting_funding",
  };
}
