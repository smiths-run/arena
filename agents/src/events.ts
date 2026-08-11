/**
 * The chain, read once, as the platform's own record of what happened.
 *
 * Three logs — a launch, a buy, a sell — become one stream of "somebody did
 * something", keyed by transaction hash and log index so the same fact can be
 * re-read a hundred times and land once. Everything that watches other agents
 * reads from here rather than from the chain directly: a rule that reacts to
 * @mfmf must react to exactly one launch, not to one launch per restart.
 *
 * Two properties are deliberate.
 *
 * Confirmations: the head of a fast chain is provisional, and a trade made
 * against a block that later disappears is real money spent on a phantom. The
 * walk stops short of the head by a couple of blocks; the cost is under a
 * second of latency, and the alternative is buying into a reorg.
 *
 * Timestamps come from block headers, not from our clock. "@mfmf launched at
 * 00:14:02" should mean what the chain says, and a block is fetched once per
 * batch that contains an event — a few dozen reads for the whole backfill.
 */
import { parseAbi } from "viem";
import { MARKETS } from "./shared.ts";
import { pub } from "./observe.ts";
import { actorOf, actorByHandle, type Actor } from "./actors.ts";
import * as store from "./store.ts";

const eventAbi = parseAbi([
  "event MarketLaunched(uint256 indexed id, address indexed token, address indexed creator, string name, string symbol, uint256 initialBuy)",
  "event Bought(uint256 indexed id, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
  "event Sold(uint256 indexed id, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
]);

/** Where the platform's first market was launched; nothing exists before it. */
const DEPLOY_BLOCK = BigInt(process.env.MARKETS_DEPLOY_BLOCK ?? "55002424");

/** Arc's public endpoints cap eth_getLogs at 10,000 blocks counting both ends. */
const RANGE = 9_999n;

/**
 * How far behind the head to stay.
 *
 * Arc produces a block roughly every half second, so two blocks is about a
 * second of delay in exchange for not acting on a block that may still be
 * reorganised away.
 */
export const CONFIRMATIONS = 2n;

/**
 * How many ranges one backfill pass covers before yielding to other work.
 *
 * The endpoints rate-limit per caller, and the agents share that budget with
 * this walk: a pass that reads too far starves the runs it exists to serve,
 * and the endpoints answer the whole process with "rate limit exceeded" rather
 * than only the greedy caller. Four ranges is roughly forty thousand blocks a
 * pass — the whole history in a few minutes without anyone noticing.
 */
const BACKFILL_RANGES_PER_PASS = 4;

/** Past this distance from the head we are catching up, not watching. */
const LIVE_WINDOW = 200n;

export function cursor(): bigint {
  const stored = store.settingGet("events_cursor_block");
  return stored ? BigInt(stored) : DEPLOY_BLOCK;
}

export interface IngestResult {
  /** How many events the ledger had never seen. */
  appended: number;
  at: bigint;
  head: bigint;
  /** True once the walk is at the head and merely watching it. */
  live: boolean;
}

export function ingestStatus(): { cursor: string; head: string; live: boolean } {
  const at = cursor();
  const head = BigInt(store.settingGet("events_head_block") ?? "0");
  return { cursor: at.toString(), head: head.toString(), live: head > 0n && head - at <= LIVE_WINDOW };
}

const blockTimes = new Map<string, number>();

async function timestampOf(blockNumber: bigint): Promise<number> {
  const key = blockNumber.toString();
  const hit = blockTimes.get(key);
  if (hit !== undefined) return hit;
  const block = (await pub.getBlock({ blockNumber })) as { timestamp: bigint };
  const ms = Number(block.timestamp) * 1000;
  // Only blocks that carried an event are ever asked for, and the map is
  // trimmed so a long-running process does not accumulate the whole chain.
  if (blockTimes.size > 500) blockTimes.clear();
  blockTimes.set(key, ms);
  return ms;
}

/**
 * Advance the walk and append whatever it finds.
 *
 * Behind the head this catches up in wide ranges; at the head it is a single
 * narrow read that usually returns nothing and costs about a tenth of a second.
 */
export async function ingest(): Promise<IngestResult> {
  const head = await pub.getBlockNumber();
  store.settingSet("events_head_block", head.toString());
  const safeHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n;

  let at = cursor();
  let appended = 0;
  const catchingUp = safeHead - at > LIVE_WINDOW;
  const passes = catchingUp ? BACKFILL_RANGES_PER_PASS : 1;

  for (let i = 0; i < passes && at <= safeHead; i++) {
    const to = at + RANGE > safeHead ? safeHead : at + RANGE;
    // A refused read ends the pass rather than the process. The cursor only
    // moves after a range lands, so the next pass resumes exactly here and a
    // rate limit costs a few seconds instead of a gap in the record.
    let logs: Array<{
      eventName: "MarketLaunched" | "Bought" | "Sold";
      args: {
        id?: bigint;
        creator?: `0x${string}`;
        buyer?: `0x${string}`;
        seller?: `0x${string}`;
        name?: string;
        symbol?: string;
        initialBuy?: bigint;
        usdcIn?: bigint;
        usdcOut?: bigint;
        tokensOut?: bigint;
        tokensIn?: bigint;
      };
      blockNumber: bigint;
      transactionHash: `0x${string}`;
      logIndex: number;
    }>;
    try {
      logs = (await pub.getLogs({
        address: MARKETS as `0x${string}`,
        events: eventAbi,
        fromBlock: at,
        toBlock: to,
      })) as typeof logs;
    } catch {
      break;
    }

    const rows: store.PlatformEventInput[] = [];
    let stalled = false;
    for (const log of logs) {
      if (log.args.id === undefined) continue;
      let at_: number;
      try {
        at_ = await timestampOf(log.blockNumber);
      } catch {
        // Without the block's own time we would have to invent one. Stop the
        // pass instead and read this range again when the endpoints recover.
        stalled = true;
        break;
      }
      const base = {
        id: `${log.transactionHash.toLowerCase()}:${log.logIndex}`,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        txHash: log.transactionHash,
        at: at_,
        marketId: log.args.id,
      };
      if (log.eventName === "MarketLaunched") {
        rows.push({
          ...base,
          type: "market_launched",
          actorWallet: log.args.creator ?? "",
          usdc: log.args.initialBuy ?? 0n,
          symbol: log.args.symbol ?? "",
          name: log.args.name ?? "",
        });
      } else if (log.eventName === "Bought") {
        rows.push({
          ...base,
          type: "buy",
          actorWallet: log.args.buyer ?? "",
          usdc: log.args.usdcIn ?? 0n,
          tokens: log.args.tokensOut ?? 0n,
        });
      } else {
        rows.push({
          ...base,
          type: "sell",
          actorWallet: log.args.seller ?? "",
          usdc: log.args.usdcOut ?? 0n,
          tokens: log.args.tokensIn ?? 0n,
        });
      }
    }

    if (stalled) break;
    appended += store.eventsAppend(rows);
    at = to + 1n;
    store.settingSet("events_cursor_block", at.toString());
    if (to === safeHead) break;
  }

  return { appended, at, head, live: safeHead - at <= LIVE_WINDOW };
}

// ── reading the record back ────────────────────────────────────────────────

export interface EventView {
  id: string;
  type: store.PlatformEventType;
  at: number;
  blockNumber: string;
  txHash: string;
  actor: Actor;
  marketId: string;
  symbol: string;
  usdc: string;
  tokens: string;
}

/**
 * An event with its actor named.
 *
 * Attribution is applied here rather than stored, so an agent that registers
 * its handle tomorrow is named in yesterday's events too — the wallet is the
 * fact, the handle is the current reading of it.
 */
export function view(row: store.PlatformEventRow): EventView {
  return {
    id: row.id,
    type: row.type,
    at: row.at,
    blockNumber: row.blockNumber,
    txHash: row.txHash,
    actor: actorOf(row.actorWallet),
    marketId: row.marketId,
    symbol: row.symbol || (store.marketSymbol(row.marketId) ?? ""),
    usdc: row.usdc,
    tokens: row.tokens,
  };
}

const usd = (v: string) => (Number(v) / 1e6).toFixed(6).replace(/\.?0+$/, "");

/** One event as a line a person or an agent reads. */
export function describe(v: EventView): string {
  const who = v.actor.handle ? `@${v.actor.handle}` : `external:${v.actor.wallet.slice(0, 8)}`;
  const what = v.symbol ? `$${v.symbol}` : `market ${v.marketId}`;
  switch (v.type) {
    case "market_launched":
      return `${who} launched ${what} with ${usd(v.usdc)} USDC`;
    case "buy":
      return `${who} bought ${usd(v.usdc)} USDC of ${what}`;
    case "sell":
      return `${who} sold ${usd(v.usdc)} USDC of ${what}`;
  }
}

/** The platform's recent record, newest first. */
export function recent(limit = 40): EventView[] {
  return store.eventsRecent(limit).map(view);
}

/** What one agent has done, newest first. Unknown handles have no history. */
export function activityOf(handle: string, limit = 40, sinceMs = 0): EventView[] {
  const actor = actorByHandle(handle);
  return actor ? store.eventsByActor(actor.wallet, limit, sinceMs).map(view) : [];
}

/** Markets an agent launched, newest first. */
export function launchesOf(handle: string, limit = 40): EventView[] {
  return activityOf(handle, 200).filter((e) => e.type === "market_launched").slice(0, limit);
}

export function marketActivity(marketId: bigint | string, limit = 40): EventView[] {
  return store.eventsByMarket(marketId, limit).map(view);
}
