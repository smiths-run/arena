/**
 * A run receipt the agent signs itself.
 *
 * Trades are settled onchain and anyone can check them. Refusals are not — and
 * refusing is the behaviour the product is proudest of. Until now those sat in
 * our own SQLite, which means "you can check what the agent did" was true for
 * actions and merely a promise for inaction. A reader had to trust our database.
 *
 * So every run ends with a canonical receipt signed by the agent's own wallet
 * through Circle. That does not put the refusal onchain, and it is not claimed
 * to: what it gives is attribution and tamper-evidence. The signature is over a
 * deterministic hash of the run — its observation, its proposed action, the
 * policy verdict, what it cost and what it settled — so if any of that is edited
 * afterwards the signature stops verifying, and the address that signed it is
 * the same one that holds the agent's ERC-8004 identity.
 *
 * Verification needs nothing from us: the receipt, the signature, and a public
 * `eth_call`.
 */
import { createHash } from "node:crypto";
import type { circle } from "./shared.ts";
import { circleSigner } from "./circle-signer.ts";

/** EIP-712 domain for run receipts. Distinct from any payment domain. */
export const RECEIPT_DOMAIN = {
  name: "Smiths Run Receipt",
  version: "1",
  chainId: 5042002,
  // Receipts are attestations, not transactions: no contract verifies them, so the
  // domain names the identity registry the signer is registered in rather than a
  // spender that could move funds.
  verifyingContract: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as `0x${string}`,
};

export const RECEIPT_TYPES = {
  RunReceipt: [
    { name: "agent", type: "address" },
    { name: "runId", type: "uint256" },
    { name: "outcome", type: "string" },
    { name: "detailsHash", type: "bytes32" },
  ],
} as const;

export interface ReceiptBody {
  agent: string;
  agentName: string;
  runId: number;
  trigger: string;
  outcome: string;
  actionKind: string | null;
  reason: string | null;
  marketId: string | null;
  txHash: string | null;
  usdc: string | null;
  intelCost: string | null;
  intelVerdict: string | null;
  equityOpen: string | null;
  equityClose: string | null;
  netResult: string | null;
  codeVersion: string;
}

/**
 * Deterministic hash of the receipt body. Keys are sorted so the same run always
 * hashes the same way regardless of how the object was built.
 */
export function detailsHash(body: ReceiptBody): `0x${string}` {
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  return `0x${createHash("sha256").update(canonical).digest("hex")}`;
}

export interface SignedReceipt {
  body: ReceiptBody;
  detailsHash: `0x${string}`;
  signature: `0x${string}`;
  domain: typeof RECEIPT_DOMAIN;
  primaryType: "RunReceipt";
}

export async function signReceipt(
  client: ReturnType<typeof circle>,
  agent: { name: string; walletId: string; address: `0x${string}` },
  body: ReceiptBody,
): Promise<SignedReceipt> {
  const hash = detailsHash(body);

  // A receipt carries no value and names no payee, so the payment mandate is empty
  // — the guard's job here is to refuse anything that is not a receipt.
  const signer = circleSigner(client, agent.walletId, agent.address, {
    maxValueUsdc: 0n,
    payeeAllowlist: new Set(),
  });

  const signature = await signer.signTypedData({
    domain: RECEIPT_DOMAIN,
    types: RECEIPT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    primaryType: "RunReceipt",
    message: {
      agent: agent.address,
      runId: BigInt(body.runId),
      outcome: body.outcome,
      detailsHash: hash,
    },
  });

  return { body, detailsHash: hash, signature, domain: RECEIPT_DOMAIN, primaryType: "RunReceipt" };
}
