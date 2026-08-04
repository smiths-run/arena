/**
 * The local consequences of a confirmed transaction, derived from its receipt.
 *
 * Writing these inline after `submit()` returns leaves a window: the chain has
 * moved, the process dies, and the agent wakes up with a position it does not
 * know it holds and daily spend it does not know it made. The policy engine would
 * then judge on false numbers — the one thing it must never do.
 *
 * So side effects live here instead, keyed by transaction hash and guarded by an
 * `applied` flag. The live path calls this immediately; the recovery path calls
 * exactly the same function for anything that completed while nobody was
 * listening. Applying twice is a no-op, and the local database is reconstructible
 * from the chain rather than being a second source of truth.
 */
import { decodeEventLog, parseAbi } from "viem";
import { MARKETS } from "./shared.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

const marketsEventsAbi = parseAbi([
  "event MarketLaunched(uint256 indexed id, address indexed token, address indexed creator, string name, string symbol, uint256 initialBuy)",
  "event Bought(uint256 indexed id, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
  "event Sold(uint256 indexed id, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
]);

export interface AppliedEffects {
  marketId: bigint | null;
  tokens: bigint;
  usdcMoved: bigint;
}

/**
 * Read a confirmed transaction and write whatever it implies about the agent's
 * position and spend. Idempotent: a second call for the same key does nothing.
 */
export async function applyEffects(
  idempotencyKey: string,
  agentName: string,
  txHash: `0x${string}`,
): Promise<AppliedEffects> {
  const already = store.isApplied(idempotencyKey);
  const receipt = await obs.pub.waitForTransactionReceipt({ hash: txHash });

  let marketId: bigint | null = null;
  let tokens = 0n;
  let usdcMoved = 0n;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MARKETS.toLowerCase()) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: marketsEventsAbi, data: log.data, topics: log.topics });
    } catch {
      continue; // an event from another ABI in the same transaction
    }

    if (decoded.eventName === "MarketLaunched") {
      marketId = decoded.args.id;
    } else if (decoded.eventName === "Bought") {
      marketId = decoded.args.id;
      tokens = decoded.args.tokensOut;
      usdcMoved = decoded.args.usdcIn;
      if (!already) {
        store.positionAdd(agentName, decoded.args.id, decoded.args.tokensOut, decoded.args.usdcIn);
        store.spendRecord(agentName, decoded.args.usdcIn);
      }
    } else if (decoded.eventName === "Sold") {
      marketId = decoded.args.id;
      tokens = decoded.args.tokensIn;
      usdcMoved = decoded.args.usdcOut;
      if (!already) {
        store.positionReduce(agentName, decoded.args.id, decoded.args.tokensIn);
      }
    }
  }

  if (!already) store.markApplied(idempotencyKey);
  return { marketId, tokens, usdcMoved };
}
