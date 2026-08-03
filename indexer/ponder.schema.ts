import { index, onchainTable, primaryKey } from "ponder";

/** One row per bonding-curve market. Reserves mirror the contract's virtual reserves. */
export const market = onchainTable(
  "market",
  (t) => ({
    id: t.bigint().primaryKey(),
    token: t.hex().notNull(),
    creator: t.hex().notNull(),
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    reserveUsdc: t.bigint().notNull(),
    reserveToken: t.bigint().notNull(),
    /** Lifetime USDC that has flowed through this market, gross of fees. */
    volumeUsdc: t.bigint().notNull(),
    tradeCount: t.integer().notNull(),
    creatorFeesAccrued: t.bigint().notNull(),
    creatorFeesClaimed: t.bigint().notNull(),
    createdAtBlock: t.bigint().notNull(),
    createdAtTx: t.hex().notNull(),
  }),
  (table) => ({
    creatorIdx: index().on(table.creator),
  }),
);

/** Every buy and sell, ordered by (blockNumber, logIndex) — never by timestamp. */
export const trade = onchainTable(
  "trade",
  (t) => ({
    txHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    marketId: t.bigint().notNull(),
    trader: t.hex().notNull(),
    side: t.text().notNull(), // "buy" | "sell"
    /** USDC in (buy) or out (sell), gross of fees. */
    usdc: t.bigint().notNull(),
    tokens: t.bigint().notNull(),
    impactBps: t.bigint().notNull(),
    reserveUsdcAfter: t.bigint().notNull(),
    reserveTokenAfter: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.txHash, table.logIndex] }),
    marketIdx: index().on(table.marketId),
    traderIdx: index().on(table.trader),
    orderIdx: index().on(table.blockNumber, table.logIndex),
  }),
);

/** Fee payouts, both creator and protocol. */
export const feeClaim = onchainTable(
  "fee_claim",
  (t) => ({
    txHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    kind: t.text().notNull(), // "creator" | "protocol"
    marketId: t.bigint(), // null for protocol claims
    to: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.txHash, table.logIndex] }),
  }),
);

/** Per-address rollup: every wallet that has ever traded, and what it did. */
export const account = onchainTable("account", (t) => ({
  address: t.hex().primaryKey(),
  tradeCount: t.integer().notNull(),
  buyVolumeUsdc: t.bigint().notNull(),
  sellVolumeUsdc: t.bigint().notNull(),
  marketsCreated: t.integer().notNull(),
  creatorFeesEarned: t.bigint().notNull(),
  firstSeenBlock: t.bigint().notNull(),
  lastSeenBlock: t.bigint().notNull(),
}));

/** Singleton protocol-wide counters (id is always 0). */
export const stats = onchainTable("stats", (t) => ({
  id: t.integer().primaryKey(),
  marketCount: t.integer().notNull(),
  tradeCount: t.integer().notNull(),
  volumeUsdc: t.bigint().notNull(),
  protocolFeesClaimed: t.bigint().notNull(),
  creatorFeesClaimed: t.bigint().notNull(),
}));

/** ERC-8004 identities registered in our indexing window — ours and self-hosted. */
export const agent = onchainTable(
  "agent",
  (t) => ({
    agentId: t.bigint().primaryKey(),
    owner: t.hex().notNull(),
    uri: t.text().notNull(),
    /** Best-effort fields parsed from a data:application/json URI; null otherwise. */
    name: t.text(),
    agentType: t.text(),
    registeredAtBlock: t.bigint().notNull(),
    registeredAtTx: t.hex().notNull(),
  }),
  (table) => ({
    ownerIdx: index().on(table.owner),
  }),
);
