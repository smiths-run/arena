/**
 * A BatchEvmSigner backed by Circle — the answer to the custody question spike 03
 * left open. The x402 batching SDK only needs `{ address, signTypedData }`, and
 * Circle's wallet API signs EIP-712 typed data server-side. So an agent can pay
 * x402 invoices from its own custodied wallet: no key is ever exported, held in
 * memory, or written to disk anywhere in this system.
 */
import { circle } from "./shared.ts";

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

export function circleSigner(
  client: ReturnType<typeof circle>,
  walletId: string,
  address: `0x${string}`,
): CircleSigner {
  return {
    address,
    async signTypedData(params) {
      // EIP-712 numeric fields arrive as bigints (value, validAfter, validBefore,
      // chainId). JSON has no bigint, and the spec encodes them as decimal
      // strings, so convert rather than let JSON.stringify throw.
      const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

      // Circle expects the complete EIP-712 document, including the domain type.
      const data = JSON.stringify({
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
      }, replacer);

      const res = await client.signTypedData({ walletId, data });
      const signature = res.data?.signature;
      if (!signature) throw new Error("circle signTypedData returned no signature");
      return signature as `0x${string}`;
    },
  };
}
