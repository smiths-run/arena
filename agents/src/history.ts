/**
 * Lifetime volume per market, walked from the chain a few ranges at a time.
 *
 * There is a real indexer for history, and on a private RPC it is the right
 * tool. On the public Arc endpoints it is not: a backfill wants a hundred-odd
 * eth_getLogs in a burst, the endpoints rate-limit per caller, and the sync
 * collapsed into a crawl that measured 0 blocks a minute — leaving the site
 * with a Volume column full of dashes it could not fill.
 *
 * This is the patient version of the same job. Each pass advances a cursor by
 * a handful of ranges, aggregates buys and sells per market, and stores both
 * the totals and how far it has read. It is resumable by construction: a
 * restart continues from the cursor rather than starting over, and finishing
 * the history costs about a hundred requests spread over a few minutes.
 *
 * The chain is the only source here — no indexer, no trust in our own past
 * arithmetic beyond the cursor.
 */
import { parseAbi } from "viem";
import { MARKETS } from "./shared.ts";
import { pub } from "./observe.ts";
import * as store from "./store.ts";

const flowAbi = parseAbi([
  "event Bought(uint256 indexed id, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
  "event Sold(uint256 indexed id, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
]);

/** The block the Markets contract was deployed in; there is no history before it. */
const DEPLOY_BLOCK = BigInt(process.env.MARKETS_DEPLOY_BLOCK ?? "55002424");

/** One short of the 10,000-block cap every public Arc endpoint enforces. */
const RANGE = 9_999n;

/** Ranges per pass. Small enough to stay inside the rate limit beside everything else. */
const RANGES_PER_PASS = 4;

/** How far the walk has read. */
export function cursor(): bigint {
  const stored = store.settingGet("history_cursor_block");
  return stored ? BigInt(stored) : DEPLOY_BLOCK;
}

/**
 * Where the walk is, without asking the chain. The head is remembered as the
 * walk goes, so a reader — the site included — can be told how complete these
 * totals are without paying an RPC call to find out.
 */
export function historyStatus(): { cursor: string; head: string; caughtUp: boolean } {
  const at = cursor();
  const head = BigInt(store.settingGet("history_head_block") ?? "0");
  return { cursor: at.toString(), head: head.toString(), caughtUp: head > 0n && at > head };
}

/**
 * Read the next few ranges. Returns how far it now reaches and whether the
 * walk has caught up with the chain — a caller can show real progress rather
 * than a spinner that means nothing.
 */
export async function advanceHistory(): Promise<{ at: bigint; head: bigint; caughtUp: boolean }> {
  const head = await pub.getBlockNumber();
  store.settingSet("history_head_block", head.toString());
  let at = cursor();

  for (let i = 0; i < RANGES_PER_PASS && at < head; i++) {
    const to = at + RANGE > head ? head : at + RANGE;
    const logs = (await pub.getLogs({
      address: MARKETS as `0x${string}`,
      events: flowAbi,
      fromBlock: at,
      toBlock: to,
    })) as Array<{
      eventName: "Bought" | "Sold";
      args: { id?: bigint; usdcIn?: bigint; usdcOut?: bigint };
    }>;

    const deltas = new Map<string, { usdc: bigint; count: number }>();
    for (const log of logs) {
      if (log.args.id === undefined) continue;
      const key = log.args.id.toString();
      const acc = deltas.get(key) ?? { usdc: 0n, count: 0 };
      acc.usdc += log.args.usdcIn ?? log.args.usdcOut ?? 0n;
      acc.count += 1;
      deltas.set(key, acc);
    }

    // Volume is summed, so replaying a range would double-count it and
    // skipping one would lose it. The totals and the cursor that produced them
    // therefore move in a single transaction.
    at = to + 1n;
    store.applyHistoryRange(deltas, at.toString());
  }

  return { at, head, caughtUp: at > head };
}
