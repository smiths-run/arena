/**
 * Visitor agent creation: one Circle wallet, one faucet request, one row.
 *
 * The custody model is identical to the house agents — the visitor never sees
 * a private key because there is none to see; the wallet is developer-
 * controlled and the policy engine governs what it may sign. Funding comes
 * from Circle's programmatic faucet (20 USDC per address per 2h), so a
 * visitor goes from a name to a funded, running agent in one request. If the
 * faucet declines, the agent still exists — it just waits, and its runs say
 * so in public like every other refusal.
 */
import { circle } from "./shared.ts";
import {
  MAX_PER_IP_PER_DAY,
  MAX_USER_AGENTS,
  planVisitorAgent,
  serializeStrategy,
  type VisitorRequest,
} from "./visitor-strategy.ts";
import * as store from "./store.ts";

const WALLET_SET_KEY = "visitor_wallet_set_id";

export interface CreatedAgent {
  name: string;
  symbol: string;
  address: string;
  funded: boolean;
}

export async function createUserAgent(req: VisitorRequest, ip: string | null): Promise<CreatedAgent> {
  const plan = planVisitorAgent(req);

  if (store.userAgentByName(plan.name)) throw new Error(`"${plan.name}" already exists`);
  if (store.userAgentCount() >= MAX_USER_AGENTS) {
    throw new Error("the visitor roster is full for now");
  }
  if (ip && store.userAgentsCreatedBy(ip, 24 * 3600 * 1000) >= MAX_PER_IP_PER_DAY) {
    throw new Error(`limit reached: ${MAX_PER_IP_PER_DAY} agents per day`);
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

  // Funding is best-effort: the faucet rate-limits per address, and an
  // unfunded agent is not an error — its runs will publicly say it is broke.
  let funded = false;
  try {
    await client.requestTestnetTokens({
      address: wallet.address,
      blockchain: "ARC-TESTNET" as never,
      native: true,
      usdc: true,
    });
    funded = true;
  } catch {
    funded = false;
  }

  store.userAgentCreate({
    name: plan.name,
    walletId: wallet.id,
    address: wallet.address,
    strategyJson: serializeStrategy(plan.strategy),
    creatorIp: ip,
  });

  return { name: plan.name, symbol: plan.symbol, address: wallet.address, funded };
}
