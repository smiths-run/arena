/**
 * The signer's mandate is the boundary between "we do not hold a key" and "the
 * wallet only signs what we would have approved". These tests attack it the way
 * a hostile seller would: right shape, wrong details.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertWithinMandate, SignatureRefused, type SignerMandate } from "./circle-signer.ts";

const AGENT = "0xe820612807a52d714ddd4e35756f33cceb79d734" as const;
const ANALYST = "0x6af5f2514b9d5c6cafaa5cea68200ac7480d1eb5";
const ATTACKER = "0x000000000000000000000000000000000000dead";
const GATEWAY = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

const NOW = 1_800_000_000n;

const mandate: SignerMandate = {
  maxValueUsdc: 10_000n, // 0.01 USDC
  payeeAllowlist: new Set([ANALYST]),
};

function doc(overrides: {
  chainId?: number;
  verifyingContract?: string;
  primaryType?: string;
  from?: string;
  to?: string;
  value?: bigint;
  validAfter?: bigint;
  validBefore?: bigint;
} = {}) {
  return {
    domain: {
      name: "USDC",
      version: "2",
      chainId: overrides.chainId ?? 5042002,
      verifyingContract: (overrides.verifyingContract ?? GATEWAY) as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
      BurnIntent: [{ name: "x", type: "uint256" }],
    },
    primaryType: overrides.primaryType ?? "TransferWithAuthorization",
    message: {
      from: overrides.from ?? AGENT,
      to: overrides.to ?? ANALYST,
      value: overrides.value ?? 1_000n,
      validAfter: overrides.validAfter ?? NOW - 60n,
      validBefore: overrides.validBefore ?? NOW + 3_600n,
      nonce: "0x" + "11".repeat(32),
    } as Record<string, unknown>,
  };
}

const refuses = (d: ReturnType<typeof doc>, pattern: RegExp) => {
  assert.throws(() => assertWithinMandate(d, AGENT, mandate, NOW), (err: unknown) => {
    assert.ok(err instanceof SignatureRefused, `expected SignatureRefused, got ${err}`);
    assert.match((err as Error).message, pattern);
    return true;
  });
};

test("the intended payment is signed", () => {
  assertWithinMandate(doc(), AGENT, mandate, NOW);
});

test("a payment on another chain is refused", () => {
  refuses(doc({ chainId: 8453 }), /chainId 8453/);
});

test("an unknown verifying contract is refused", () => {
  refuses(doc({ verifyingContract: ATTACKER }), /unknown verifying contract/);
});

test("a typed-data document we do not recognise is refused", () => {
  refuses(doc({ primaryType: "Permit" }), /unexpected primary type/);
});

test("paying on someone else's behalf is refused", () => {
  refuses(doc({ from: ATTACKER }), /is not this agent/);
});

test("paying an address that is not the analyst is refused", () => {
  refuses(doc({ to: ATTACKER }), /not on the allowlist/);
});

test("a payment above the mandate is refused, even by one unit", () => {
  refuses(doc({ value: mandate.maxValueUsdc + 1n }), /exceeds the mandate/);
});

test("an authorization valid far into the future is refused", () => {
  refuses(doc({ validBefore: NOW + 400n * 24n * 3600n }), /beyond the/);
});

test("an already-expired authorization is refused", () => {
  refuses(doc({ validBefore: NOW - 1n }), /already expired/);
});

test("an authorization that is not yet valid is refused", () => {
  refuses(doc({ validAfter: NOW + 60n }), /not yet valid/);
});

test("a malformed amount is refused rather than coerced", () => {
  const d = doc();
  d.message.value = "not-a-number";
  refuses(d, /is not an integer/);
});

test("a value at exactly the mandate is allowed", () => {
  assertWithinMandate(doc({ value: mandate.maxValueUsdc }), AGENT, mandate, NOW);
});

test("BurnIntent skips the payment checks but still needs the right chain", () => {
  // Gateway's withdrawal flow signs a different document; it carries no payee or
  // value, so only the domain checks apply.
  assertWithinMandate(doc({ primaryType: "BurnIntent" }), AGENT, mandate, NOW);
  refuses(doc({ primaryType: "BurnIntent", chainId: 1 }), /chainId 1/);
});
