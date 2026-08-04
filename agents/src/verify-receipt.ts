/**
 * Independent verification of a signed run receipt.
 *
 *   npm run verify -- 37
 *
 * This deliberately re-derives everything rather than trusting the stored hash:
 * it rebuilds the canonical body from the run row, recomputes the details hash,
 * and recovers the signing address from the signature with viem. If the run has
 * been edited since it was signed, the recomputed hash differs and recovery
 * fails or returns a different address.
 *
 * Anyone can run the same check against a published receipt without access to
 * this database — the body, the signature and viem are the whole dependency set.
 */
import { recoverTypedDataAddress } from "viem";
import { AGENTS } from "./shared.ts";
import { RECEIPT_DOMAIN, RECEIPT_TYPES, detailsHash, type ReceiptBody } from "./receipt.ts";
import * as store from "./store.ts";

const runId = Number(process.argv[2] ?? process.env.RUN_ID);
if (!Number.isFinite(runId)) throw new Error("usage: npm run verify -- <runId>");

const row = store.runById(runId) as Record<string, string | null> | undefined;
if (!row) throw new Error(`no run ${runId}`);
if (!row.receipt_signature) throw new Error(`run ${runId} has no signed receipt`);

const agentName = String(row.agent);
const agent = AGENTS.find((a) => a.name === agentName);
if (!agent) throw new Error(`unknown agent ${agentName}`);

const body: ReceiptBody = {
  agent: agent.address,
  agentName,
  runId,
  trigger: String(row.trigger_kind),
  outcome: String(row.outcome ?? "unknown"),
  actionKind: row.action_kind ?? null,
  reason: row.reason ?? null,
  marketId: row.market_id ?? null,
  txHash: row.tx_hash ?? null,
  usdc: row.usdc ?? null,
  intelCost: row.intel_cost ?? null,
  intelVerdict: row.intel_verdict ?? null,
  equityOpen: row.equity_open ?? null,
  equityClose: row.equity_close ?? null,
  netResult:
    row.equity_open && row.equity_close
      ? (BigInt(row.equity_close) - BigInt(row.equity_open)).toString()
      : null,
  codeVersion: process.env.CODE_VERSION ?? "dev",
};

const recomputed = detailsHash(body);
const stored = row.receipt_hash;

console.log(`run          #${runId} (${agentName})`);
console.log(`outcome      ${body.outcome}${body.actionKind ? ` / ${body.actionKind}` : ""}`);
console.log(`reason       ${(body.reason ?? "").slice(0, 80)}`);
console.log(`net result   ${body.netResult ?? "n/a"}`);
console.log(`stored hash  ${stored}`);
console.log(`recomputed   ${recomputed}`);
console.log(`hash matches ${stored === recomputed ? "YES" : "NO — the run was edited after signing"}`);

// viem's generics infer the message shape from `types`; the cast keeps that
// inference out of the way without loosening what is actually verified.
const recovered = await recoverTypedDataAddress({
  domain: RECEIPT_DOMAIN,
  types: RECEIPT_TYPES,
  primaryType: "RunReceipt",
  message: {
    agent: agent.address,
    runId: BigInt(runId),
    outcome: body.outcome,
    detailsHash: recomputed,
  },
  signature: row.receipt_signature as `0x${string}`,
} as Parameters<typeof recoverTypedDataAddress>[0]);

const ok = recovered.toLowerCase() === agent.address.toLowerCase();
console.log(`signed by    ${recovered}`);
console.log(`expected     ${agent.address}`);
console.log(`\n${ok && stored === recomputed ? "VALID — signed by the agent, unmodified since" : "INVALID"}`);
process.exit(ok && stored === recomputed ? 0 : 1);
