/**
 * A BatchEvmSigner backed by Circle, with a mandate.
 *
 * Not holding a private key is necessary but nowhere near sufficient. A signer
 * that forwards whatever typed data it is handed gives away exactly the authority
 * the custody model was supposed to keep: a hostile or buggy seller can craft an
 * EIP-3009 authorization that Circle will happily sign and Gateway will happily
 * honour. What matters is not "we do not hold the key" but "the wallet only ever
 * signs a payment we would have approved".
 *
 * So the guard below runs before Circle is ever called, and refuses anything it
 * cannot recognise:
 *
 *   - the chain is Arc Testnet
 *   - the verifying contract is one we expect
 *   - the primary type is a payment authorization, not something else
 *   - the payer is this agent
 *   - the payee is on the allowlist
 *   - the amount is within the strategy's cap for this purpose
 *   - the authorization expires in a sane window
 *
 * Every refusal throws with the reason, and a refusal is a run outcome rather
 * than a silent downgrade.
 */
import { circle } from "./shared.ts";

const ARC_CHAIN_ID = 5042002;

/** Contracts the agent is willing to name as the verifier of a payment. */
const ALLOWED_VERIFYING_CONTRACTS = new Set(
  [
    "0x0077777d7eba4688bdef3e311b846f25870a19b9", // Circle Gateway Wallet
    "0x3600000000000000000000000000000000000000", // USDC, for direct EIP-3009
    "0x8004a818bfb912233c491871b3d84c89a494bd9e", // ERC-8004 registry, for run receipts
  ].map((a) => a.toLowerCase()),
);

/** Typed-data documents this agent will sign at all. */
const ALLOWED_PRIMARY_TYPES = new Set(["TransferWithAuthorization", "BurnIntent", "RunReceipt"]);

/** Gateway's own authorization window is seven days; anything beyond is suspect. */
const MAX_VALIDITY_SECONDS = 604_900n + 3_600n;

export interface SignerMandate {
  /** Most this signature may ever authorise, in 6-decimal USDC base units. */
  maxValueUsdc: bigint;
  /** Addresses this agent is willing to pay. Lowercased. */
  payeeAllowlist: Set<string>;
}

interface TypedDataParams {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface CircleSigner {
  address: `0x${string}`;
  signTypedData: (params: TypedDataParams) => Promise<`0x${string}`>;
}

export class SignatureRefused extends Error {
  constructor(reason: string) {
    super(`refused to sign: ${reason}`);
    this.name = "SignatureRefused";
  }
}

function asBigInt(v: unknown, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  throw new SignatureRefused(`${field} is not an integer (${String(v)})`);
}

function asAddress(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new SignatureRefused(`${field} is not an address (${String(v)})`);
  }
  return v.toLowerCase();
}

/**
 * Check a typed-data document against the mandate. Exported so it can be tested
 * directly, without a Circle account.
 */
export function assertWithinMandate(
  params: TypedDataParams,
  agentAddress: `0x${string}`,
  mandate: SignerMandate,
  nowSeconds: bigint,
): void {
  if (params.domain.chainId !== ARC_CHAIN_ID) {
    throw new SignatureRefused(`chainId ${params.domain.chainId}, expected ${ARC_CHAIN_ID}`);
  }
  const verifying = asAddress(params.domain.verifyingContract, "verifyingContract");
  if (!ALLOWED_VERIFYING_CONTRACTS.has(verifying)) {
    throw new SignatureRefused(`unknown verifying contract ${verifying}`);
  }
  if (!ALLOWED_PRIMARY_TYPES.has(params.primaryType)) {
    throw new SignatureRefused(`unexpected primary type ${params.primaryType}`);
  }
  if (!params.types[params.primaryType]) {
    throw new SignatureRefused(`primary type ${params.primaryType} is not in the type set`);
  }

  // Only the payment authorization carries a value and a payee to check.
  if (params.primaryType !== "TransferWithAuthorization") return;

  const from = asAddress(params.message.from, "from");
  if (from !== agentAddress.toLowerCase()) {
    throw new SignatureRefused(`payer ${from} is not this agent`);
  }

  const to = asAddress(params.message.to, "to");
  if (!mandate.payeeAllowlist.has(to)) {
    throw new SignatureRefused(`payee ${to} is not on the allowlist`);
  }

  const value = asBigInt(params.message.value, "value");
  if (value > mandate.maxValueUsdc) {
    throw new SignatureRefused(`value ${value} exceeds the mandate of ${mandate.maxValueUsdc}`);
  }

  const validBefore = asBigInt(params.message.validBefore, "validBefore");
  if (validBefore <= nowSeconds) {
    throw new SignatureRefused("authorization has already expired");
  }
  if (validBefore - nowSeconds > MAX_VALIDITY_SECONDS) {
    throw new SignatureRefused(
      `authorization valid for ${validBefore - nowSeconds}s, beyond the ${MAX_VALIDITY_SECONDS}s ceiling`,
    );
  }

  const validAfter = asBigInt(params.message.validAfter, "validAfter");
  if (validAfter > nowSeconds) {
    throw new SignatureRefused("authorization is not yet valid");
  }
}

export function circleSigner(
  client: ReturnType<typeof circle>,
  walletId: string,
  address: `0x${string}`,
  mandate: SignerMandate,
): CircleSigner {
  return {
    address,
    async signTypedData(params) {
      assertWithinMandate(params, address, mandate, BigInt(Math.floor(Date.now() / 1000)));

      // EIP-712 numeric fields arrive as bigints (value, validAfter, validBefore,
      // chainId). JSON has no bigint, and the spec encodes them as decimal
      // strings, so convert rather than let JSON.stringify throw.
      const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

      // Circle expects the complete EIP-712 document, including the domain type.
      const data = JSON.stringify(
        {
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            ...params.types,
          },
          domain: params.domain,
          primaryType: params.primaryType,
          message: params.message,
        },
        replacer,
      );

      const res = await client.signTypedData({ walletId, data });
      const signature = res.data?.signature;
      if (!signature) throw new Error("circle signTypedData returned no signature");
      return signature as `0x${string}`;
    },
  };
}
