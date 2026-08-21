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
 * cannot omit a cost that leaves the agent: gas leaves the wallet, an x402
 * payment leaves the Gateway balance, and a purchase converts USDC into a
 * position priced at what it could be sold for.
 *
 * Inference is the exception, and it is worth being exact about it rather than
 * letting the sentence above imply more than it earns. The model runs on the
 * platform's own API key, so thinking costs an agent nothing and this delta
 * does not include it — see inference.ts, which prices what has been spent.
 * The fix is not a new category here; it is the agent paying for its thinking
 * the way it already pays for a report, so the money leaves the two balances
 * this function is already measuring.
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
  /** Liquidation value per market id, so callers reuse these quotes. */
  positionValues: Map<string, bigint | null>;
}

export async function equityOf(agentName: string, address: `0x${string}`): Promise<Equity> {
  const [walletUsdc, gatewayUsdc, claimableCreatorFees, positions] = await Promise.all([
    obs.walletUsdc(address),
    gatewayAvailable(address).catch(() => 0n), // no Gateway account yet reads as an error
    claimableFees(address),
    positionLiquidationValue(agentName),
  ]);

  return {
    walletUsdc,
    gatewayUsdc,
    claimableCreatorFees,
    positionValueUsdc: positions.total,
    total: walletUsdc + gatewayUsdc + claimableCreatorFees + positions.total,
    positionValues: positions.each,
  };
}

/**
 * Creator fees the agent has earned across every market it created.
 *
 * Only a market's creator can have fees on it, and who created what is already
 * in the cached registry — so this asks about the agent's own markets and no
 * others. Walking all of them here, twice per run and again on every screen
 * poll, was a second copy of a flood already fixed elsewhere.
 */
async function claimableFees(address: `0x${string}`): Promise<bigint> {
  const fees = await obs.claimableFees(address);
  return fees.reduce((sum, f) => sum + f.amount, 0n);
}

/**
 * What every position would fetch if sold now, impact included — and what each
 * one would fetch individually, since callers that show positions need exactly
 * the same quotes and should not pay for them twice.
 */
async function positionLiquidationValue(
  agentName: string,
): Promise<{ total: bigint; each: Map<string, bigint | null> }> {
  let total = 0n;
  const each = new Map<string, bigint | null>();
  for (const pos of store.positionsOf(agentName)) {
    if (pos.tokens <= 0n) continue;
    try {
      const { usdcOut } = await obs.quoteSell(pos.marketId, pos.tokens);
      total += usdcOut;
      each.set(pos.marketId.toString(), usdcOut);
    } catch {
      // A market that cannot be quoted contributes nothing rather than a guess.
      each.set(pos.marketId.toString(), null);
    }
  }
  return { total, each };
}

export function formatEquity(e: Equity): string {
  const u = (v: bigint) => (Number(v) / 1e6).toFixed(6);
  return (
    `wallet ${u(e.walletUsdc)} + gateway ${u(e.gatewayUsdc)} + fees ${u(e.claimableCreatorFees)} ` +
    `+ positions ${u(e.positionValueUsdc)} = ${u(e.total)} USDC`
  );
}
