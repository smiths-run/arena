/**
 * Buying a thought.
 *
 * The mirror of intel.ts: where that pays another agent for a report, this pays
 * the mind desk for a model call. The mechanism is deliberately identical — an
 * x402 authorization signed inside a mandate by the agent's own Circle wallet,
 * settled through Gateway, with no private key anywhere near this process — so
 * that the second paid loop is not a second invention.
 *
 * Two properties matter more than the plumbing.
 *
 * The cost is not booked anywhere. It leaves the agent's Gateway balance, and
 * equity already counts that balance, so the run's net result carries the
 * thought without a single line of new accounting. That is the whole reason to
 * move real money rather than write a number down.
 *
 * A desk that is unreachable, unaffordable or broken must never stop the agent.
 * It falls back to the heuristic and records why, which is the same ladder that
 * already handles a missing key and a spent budget. An economy that halts
 * because a model is unavailable was never autonomous.
 */
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerBatchScheme } from "@circle-fin/x402-batching/client";
import { circleSigner } from "./circle-signer.ts";
import { ensureGatewayFunds } from "./intel.ts";
import { circle } from "./shared.ts";
import { resolve } from "./roster.ts";
import * as executor from "./executor.ts";
import * as store from "./store.ts";

const ARC_TESTNET_CAIP2 = "eip155:5042002";

/** Unset means the desk is off and thinking stays on the direct path. */
export function deskUrl(): string | undefined {
  const u = process.env.INFERENCE_DESK_URL?.trim();
  return u ? u.replace(/\/$/, "") : undefined;
}

export function deskEnabled(): boolean {
  return deskUrl() !== undefined;
}

/**
 * The most an agent will authorize for one thought.
 *
 * The mandate is what makes the custody promise mean something here: the wallet
 * signs this payment and refuses a larger one, so a desk that raised its price
 * mid-flight gets a refusal rather than the agent's balance.
 */
export function maxThoughtCost(): bigint {
  return BigInt(process.env.MIND_MAX_COST_USDC ?? "20000"); // 0.02 USDC
}

/** Desks this agent is permitted to pay. Empty means the configured desk only. */
function payeeAllowlist(): Set<string> {
  return new Set(
    (process.env.MIND_DESK_ADDRESS ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface Thought {
  text: string;
  stopReason: string | null;
  costUsdc: bigint;
  settlementRef: string | null;
}

export interface ThoughtRequest {
  agentName: string;
  system?: string;
  user: string;
  schema?: Record<string, unknown>;
  effort?: string;
}

/**
 * Pay for one thought and return it. Throws if the desk or the payment fails —
 * the caller is expected to fall back rather than to retry.
 */
export async function buyThought(req: ThoughtRequest): Promise<Thought> {
  const url = deskUrl();
  if (!url) throw new Error("no inference desk is configured");

  const entry = resolve(req.agentName);
  if (!entry) throw new Error(`no agent called ${req.agentName}`);

  const cap = maxThoughtCost();
  const allow = payeeAllowlist();
  if (allow.size === 0) {
    throw new Error("MIND_DESK_ADDRESS is not set; the agent has nobody it is allowed to pay");
  }

  const client = circle();

  // Thinking is frequent, so the top-up is the thing that must not happen
  // often: one deposit covers many thoughts, and each deposit is two onchain
  // transactions the agent pays gas for.
  await ensureGatewayFunds(client, entry, (purpose, call, idem) =>
    executor.submit(
      client,
      entry,
      purpose,
      call.contractAddress,
      call.abiFunctionSignature,
      call.abiParameters,
      idem,
    ),
  );

  const signer = circleSigner(client, entry.walletId, entry.address, {
    maxValueUsdc: cap,
    payeeAllowlist: allow,
  });

  const x402 = new x402Client();
  registerBatchScheme(x402, { signer, networks: [ARC_TESTNET_CAIP2] });
  const fetchWithPayment = wrapFetchWithPayment(fetch, x402);

  const res = await fetchWithPayment(`${url}/think`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: req.agentName,
      system: req.system,
      user: req.user,
      schema: req.schema,
      effort: req.effort,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; charged?: boolean };
    throw new Error(
      `mind desk returned ${res.status}${body.charged ? " after charging" : ""}: ${body.error ?? "no detail"}`,
    );
  }

  const out = (await res.json()) as {
    text: string;
    stopReason: string | null;
    model?: string;
    usage: { inputTokens: number; outputTokens: number; cacheWrite: number; cacheRead: number };
  };

  // The desk keeps no ledger — it is a separate service with a separate
  // database, and anything it recorded would be invisible to the cost report.
  // The buyer records the call, in the process that shares the ledger with
  // everything else this agent does.
  store.llmCallRecord(
    req.agentName,
    out.model ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
    out.usage.inputTokens,
    out.usage.outputTokens,
    out.usage.cacheWrite,
    out.usage.cacheRead,
  );
  store.llmFailureClear(req.agentName);

  // What was actually settled, from the seller's own echo, rather than the
  // price the buyer expected to pay.
  let settlementRef: string | null = null;
  let costUsdc = 10_000n;
  const header = res.headers.get("payment-response");
  if (header) {
    try {
      const settled = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        transaction?: string;
        amount?: string;
      };
      settlementRef = settled.transaction ?? null;
      if (settled.amount) costUsdc = BigInt(settled.amount);
      if (costUsdc > cap) {
        // The mandate already refuses an over-cap authorization, so this should
        // be unreachable. Recording it loudly beats trusting that.
        throw new Error(`desk settled ${costUsdc} against a cap of ${cap} — mandate bypassed?`);
      }
    } catch {
      settlementRef = header.slice(0, 64);
    }
  }

  store.spendRecord(req.agentName, costUsdc);
  return { text: out.text, stopReason: out.stopReason, costUsdc, settlementRef };
}
