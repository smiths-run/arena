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

export interface CreatedAgent {
  name: string;
  symbol: string;
  address: string;
  funded: boolean;
}

/** 3 USDC: a launch (1), the untouchable reserve (0.5), trades and gas. */
export const GRANT_USDC = "3000000";

export async function treasuryGrant(
  client: ReturnType<typeof circle>,
  to: string,
): Promise<boolean> {
  const created = await client.createContractExecutionTransaction({
    walletId: process.env.TREASURY_WALLET_ID!,
    contractAddress: USDC,
    abiFunctionSignature: "transfer(address,uint256)",
    abiParameters: [to, GRANT_USDC] as never[],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const done = await client.getTransaction({
    id: created.data!.id!,
    waitForState: "COMPLETE",
    pollingInterval: 500,
  });
  return done.data?.transaction?.state === "COMPLETE";
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

  // Funding, best-effort and layered: Circle's programmatic faucet first (it
  // has been Forbidden lately, but policies change back), then a grant from
  // the visitor treasury — a wallet a human refills from the web faucet. An
  // unfunded agent is not an error; its runs will publicly say it is broke.
  let funded = false;
  try {
    await client.requestTestnetTokens({
      address: wallet.address,
      blockchain: "ARC-TESTNET" as never,
      native: true,
      usdc: true,
    });
    funded = true;
  } catch (err) {
    console.log(`faucet declined for ${plan.name}: ${err instanceof Error ? err.message : err}`);
  }

  if (!funded && process.env.TREASURY_WALLET_ID) {
    try {
      funded = await treasuryGrant(client, wallet.address);
    } catch (err) {
      console.log(`treasury grant failed for ${plan.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  store.userAgentCreate({
    name: plan.name,
    walletId: wallet.id,
    address: wallet.address,
    strategyJson: serializeStrategy(plan.strategy),
    creatorIp: ip,
    // Not funded at birth → granted stays 0 and the orchestrator's funding
    // sweep keeps trying until the treasury delivers.
    granted: funded,
  });

  return { name: plan.name, symbol: plan.symbol, address: wallet.address, funded };
}
