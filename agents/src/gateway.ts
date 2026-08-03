/**
 * Gateway balance and deposits for Circle-custodied agents.
 *
 * The balance read is the public Gateway API. The deposit is two ordinary
 * contract executions from the agent's own wallet — approve, then
 * GatewayWallet.deposit(usdc, amount) — through the same pending-row-first
 * executor discipline as every other onchain action.
 */
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const GATEWAY_API = "https://gateway-api-testnet.circle.com/v1";
const ARC_DOMAIN = 26;
const USDC = "0x3600000000000000000000000000000000000000";

/** Available (spendable) Gateway balance in 6-decimal base units. */
export async function gatewayAvailable(depositor: `0x${string}`): Promise<bigint> {
  const res = await fetch(`${GATEWAY_API}/balances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ depositor, domain: ARC_DOMAIN }] }),
  });
  const data = (await res.json()) as { balances?: Array<{ balance: string }>; message?: string };
  if (!res.ok) throw new Error(`gateway balances: ${data.message ?? res.status}`);
  const text = data.balances?.[0]?.balance ?? "0";
  // API returns a decimal string; convert to 6-dec base units without float drift.
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

export const gatewayDeposit = {
  address: GATEWAY_WALLET,
  usdc: USDC,
  /** approve + deposit calls in executor-submittable form */
  approveCall: (amount: bigint) => ({
    contractAddress: USDC,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [GATEWAY_WALLET, amount.toString()],
  }),
  depositCall: (amount: bigint) => ({
    contractAddress: GATEWAY_WALLET,
    abiFunctionSignature: "deposit(address,uint256)",
    abiParameters: [USDC, amount.toString()],
  }),
};
