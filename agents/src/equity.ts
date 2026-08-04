/**
 * What an agent is actually worth, and what a run actually cost.
 *
 * The tempting way to build an honest ledger is to add up categories: trading
 * result, plus fees, minus gas, minus inference. It is also the fragile way —
 * every category is a separate reconciliation, and the one you forget is the one
 * that makes the total a lie.
 *
 * So the total is derived instead. Equity is everything the agent controls,
 * priced in USDC:
 *
 *     wallet USDC
 *   + Gateway available balance      (money committed to x402, still the agent's)
 *   + claimable creator fees          (earned, not yet withdrawn)
 *   + liquidation value of positions  (what a sell would actually return, today)
 *
 * A run's net result is closing equity minus opening equity. Nothing external
 * moves during a run, so that delta is the run's true economic outcome and it
 * cannot omit a cost: gas leaves the wallet, an x402 payment leaves the Gateway
 * balance, a purchase converts USDC into a position priced at what it could be
 * sold for, and inference — once a model is in the loop — leaves the wallet like
 * anything else.
 *
 * Positions are valued at their **liquidation** price, not their marginal price.
 * On a bonding curve, selling a position moves the price against you; quoting the
 * whole position through `quoteSell` is the honest number, and it is always the
 * smaller one.
 */
import { parseAbi } from "viem";
import { MARKETS } from "./shared.ts";
import { gatewayAvailable } from "./gateway.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

const marketsAbi = parseAbi([
  "function markets(uint256) view returns (address token, address creator, uint256 reserveUsdc, uint256 reserveToken, uint256 creatorFees, uint64 createdAtBlock)",
  "function marketCount() view returns (uint256)",
]);

export interface Equity {
  walletUsdc: bigint;
  gatewayUsdc: bigint;
  claimableCreatorFees: bigint;
  positionValueUsdc: bigint;
  total: bigint;
}

export async function equityOf(agentName: string, address: `0x${string}`): Promise<Equity> {
  const [walletUsdc, gatewayUsdc, claimableCreatorFees, positionValueUsdc] = await Promise.all([
    obs.walletUsdc(address),
    gatewayAvailable(address).catch(() => 0n), // no Gateway account yet reads as an error
    claimableFees(address),
    positionLiquidationValue(agentName),
  ]);

  return {
    walletUsdc,
    gatewayUsdc,
    claimableCreatorFees,
    positionValueUsdc,
    total: walletUsdc + gatewayUsdc + claimableCreatorFees + positionValueUsdc,
  };
}

/** Creator fees the agent has earned across every market it created. */
async function claimableFees(address: `0x${string}`): Promise<bigint> {
  const count = await obs.pub.readContract({
    address: MARKETS as `0x${string}`,
    abi: marketsAbi,
    functionName: "marketCount",
  });

  let total = 0n;
  for (let i = 0n; i < count; i++) {
    const [, creator, , , creatorFees] = await obs.pub.readContract({
      address: MARKETS as `0x${string}`,
      abi: marketsAbi,
      functionName: "markets",
      args: [i],
    });
    if (creator.toLowerCase() === address.toLowerCase()) total += creatorFees;
  }
  return total;
}

/** What every position would fetch if sold now, impact included. */
async function positionLiquidationValue(agentName: string): Promise<bigint> {
  let total = 0n;
  for (const pos of store.positionsOf(agentName)) {
    if (pos.tokens <= 0n) continue;
    try {
      const { usdcOut } = await obs.quoteSell(pos.marketId, pos.tokens);
      total += usdcOut;
    } catch {
      // A market that cannot be quoted contributes nothing rather than a guess.
    }
  }
  return total;
}

export function formatEquity(e: Equity): string {
  const u = (v: bigint) => (Number(v) / 1e6).toFixed(6);
  return (
    `wallet ${u(e.walletUsdc)} + gateway ${u(e.gatewayUsdc)} + fees ${u(e.claimableCreatorFees)} ` +
    `+ positions ${u(e.positionValueUsdc)} = ${u(e.total)} USDC`
  );
}
