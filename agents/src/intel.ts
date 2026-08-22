/**
 * The buyer half of agent-to-agent commerce.
 *
 * anvil pays bellows for a report using its own Circle-custodied wallet: the
 * x402 batching SDK asks for an EIP-712 signature, Circle produces it server
 * side, and Gateway settles the batch. No private key is exported, held in
 * memory, or written to disk anywhere in this system — the custody promise
 * survives contact with agent-to-agent payments, which is the question spike 03
 * left open.
 */
import { x402Client } from "@x402/fetch";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerBatchScheme } from "@circle-fin/x402-batching/client";
import type { Report } from "./report.ts";
import { circleSigner } from "./circle-signer.ts";
import { gatewayAvailable, gatewayDeposit } from "./gateway.ts";
import { AGENTS, type circle } from "./shared.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

const ANALYST_URL = process.env.ANALYST_URL ?? "http://localhost:42071";
const ARC_TESTNET_CAIP2 = "eip155:5042002";

/** Enough for ~200 reports; topping up on every run would burn a transaction each time. */
const GATEWAY_MIN = 20_000n; // 0.02 USDC
const GATEWAY_TOPUP = 200_000n; // 0.20 USDC

export interface Agent {
  name: string;
  walletId: string;
  address: `0x${string}`;
}

/** Analyst desks this agent is permitted to pay. */
function payeeAllowlist(): Set<string> {
  const bellows = AGENTS.find((a) => a.name === "bellows");
  const extra = (process.env.INTEL_PAYEE_ALLOWLIST ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...(bellows ? [bellows.address.toLowerCase()] : []), ...extra]);
}

export interface PurchasedIntel {
  report: Report;
  costUsdc: bigint;
  settlementRef: string | null;
}

/**
 * Ensure the agent has spendable Gateway balance, depositing from its wallet if
 * not. Deposits go through the same executor discipline as any other action.
 *
 * `keepBackUsdc` is what must survive in the wallet afterwards — the operating
 * reserve and the gas headroom. Every trade already respects it, but this path
 * did not: it moved a fixed sum out of the wallet regardless of what was left.
 * That was survivable while only an occasional report purchase came through
 * here. Thinking comes through here constantly, and an agent topped up into a
 * wallet too thin to pay for its own exit is bricked in the one currency Arc
 * charges gas in.
 */
export async function ensureGatewayFunds(
  client: ReturnType<typeof circle>,
  agent: Agent,
  submit: (
    purpose: string,
    call: { contractAddress: string; abiFunctionSignature: string; abiParameters: unknown[] },
    idem: (string | number)[],
  ) => Promise<string>,
  keepBackUsdc = 0n,
): Promise<bigint> {
  let available = 0n;
  try {
    available = await gatewayAvailable(agent.address);
  } catch {
    // No Gateway account yet reads as an error from the API; treat it as zero.
    available = 0n;
  }
  if (available >= GATEWAY_MIN) return available;

  if (keepBackUsdc > 0n) {
    const wallet = await obs.walletUsdc(agent.address);
    if (wallet - GATEWAY_TOPUP < keepBackUsdc) {
      throw new Error(
        `cannot afford to top up Gateway: ${Number(wallet) / 1e6} USDC in the wallet, ` +
          `${Number(GATEWAY_TOPUP) / 1e6} to deposit, and ${Number(keepBackUsdc) / 1e6} ` +
          `must stay behind for the reserve and gas`,
      );
    }
  }

  await submit("gateway-approve", gatewayDeposit.approveCall(GATEWAY_TOPUP), [
    "gateway-approve",
    agent.address,
    Date.now(),
  ]);
  await submit("gateway-deposit", gatewayDeposit.depositCall(GATEWAY_TOPUP), [
    "gateway-deposit",
    agent.address,
    Date.now(),
  ]);

  // Arc makes a Gateway deposit spendable in about half a second; poll briefly
  // rather than assume.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      available = await gatewayAvailable(agent.address);
      if (available >= GATEWAY_MIN) return available;
    } catch {
      /* keep polling */
    }
  }
  return available;
}

/** Buy one report about `marketId`. Throws if the payment or the report fails. */
export async function buyReport(
  client: ReturnType<typeof circle>,
  agent: Agent,
  marketId: bigint,
  runId: number | null,
  maxCostUsdc: bigint,
): Promise<PurchasedIntel> {
  // The mandate is what makes the custody promise mean something: the wallet will
  // sign this payment and refuse anything else, including a larger one.
  const signer = circleSigner(client, agent.walletId, agent.address, {
    maxValueUsdc: maxCostUsdc,
    payeeAllowlist: payeeAllowlist(),
  });

  const x402 = new x402Client();
  registerBatchScheme(x402, { signer, networks: [ARC_TESTNET_CAIP2] });
  const fetchWithPayment = wrapFetchWithPayment(fetch, x402);

  const url = `${ANALYST_URL}/report/${marketId}`;
  const res = await fetchWithPayment(url);
  if (!res.ok) {
    throw new Error(`analyst returned ${res.status} for market ${marketId}`);
  }

  const report = (await res.json()) as Report;

  // The seller echoes settlement details in a base64 PAYMENT-RESPONSE header.
  // Decoding it is how the buyer learns the settlement id and the exact amount
  // charged, rather than trusting the price it expected to pay.
  let settlementRef: string | null = null;
  let costUsdc = 1_000n; // the desk's posted price, unless settlement says otherwise

  const header = res.headers.get("payment-response");
  if (header) {
    try {
      const settled = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        transaction?: string;
        amount?: string;
      };
      settlementRef = settled.transaction ?? null;
      if (settled.amount) costUsdc = BigInt(settled.amount);
      if (costUsdc > maxCostUsdc) {
        // The signature guard already refuses an over-cap authorization, so this
        // should be unreachable. Recording it loudly beats trusting that.
        throw new Error(
          `analyst settled ${costUsdc} against a cap of ${maxCostUsdc} — signature guard bypassed?`,
        );
      }
    } catch {
      settlementRef = header.slice(0, 64);
    }
  }

  store.intelPurchaseRecord({
    runId,
    buyer: agent.address,
    marketId,
    costUsdc,
    verdict: report.verdict,
    settlementRef,
  });

  return { report, costUsdc, settlementRef };
}
