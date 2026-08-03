import { ponder } from "ponder:registry";
import { account, feeClaim, market, stats, trade } from "ponder:schema";

const STATS_ID = 0;

/** Creator fee share of the total fee, mirroring the contract's constants. */
const CREATOR_FEE_BPS = 30n;
const TOTAL_FEE_BPS = 100n;

async function touchAccount(
  db: any,
  address: `0x${string}`,
  blockNumber: bigint,
  patch: Partial<{
    tradeCount: number;
    buyVolumeUsdc: bigint;
    sellVolumeUsdc: bigint;
    marketsCreated: number;
    creatorFeesEarned: bigint;
  }>,
) {
  await db
    .insert(account)
    .values({
      address,
      tradeCount: patch.tradeCount ?? 0,
      buyVolumeUsdc: patch.buyVolumeUsdc ?? 0n,
      sellVolumeUsdc: patch.sellVolumeUsdc ?? 0n,
      marketsCreated: patch.marketsCreated ?? 0,
      creatorFeesEarned: patch.creatorFeesEarned ?? 0n,
      firstSeenBlock: blockNumber,
      lastSeenBlock: blockNumber,
    })
    .onConflictDoUpdate((row: typeof account.$inferSelect) => ({
      tradeCount: row.tradeCount + (patch.tradeCount ?? 0),
      buyVolumeUsdc: row.buyVolumeUsdc + (patch.buyVolumeUsdc ?? 0n),
      sellVolumeUsdc: row.sellVolumeUsdc + (patch.sellVolumeUsdc ?? 0n),
      marketsCreated: row.marketsCreated + (patch.marketsCreated ?? 0),
      creatorFeesEarned: row.creatorFeesEarned + (patch.creatorFeesEarned ?? 0n),
      lastSeenBlock: blockNumber,
    }));
}

async function bumpStats(
  db: any,
  patch: Partial<{
    marketCount: number;
    tradeCount: number;
    volumeUsdc: bigint;
    protocolFeesClaimed: bigint;
    creatorFeesClaimed: bigint;
  }>,
) {
  await db
    .insert(stats)
    .values({
      id: STATS_ID,
      marketCount: patch.marketCount ?? 0,
      tradeCount: patch.tradeCount ?? 0,
      volumeUsdc: patch.volumeUsdc ?? 0n,
      protocolFeesClaimed: patch.protocolFeesClaimed ?? 0n,
      creatorFeesClaimed: patch.creatorFeesClaimed ?? 0n,
    })
    .onConflictDoUpdate((row: typeof stats.$inferSelect) => ({
      marketCount: row.marketCount + (patch.marketCount ?? 0),
      tradeCount: row.tradeCount + (patch.tradeCount ?? 0),
      volumeUsdc: row.volumeUsdc + (patch.volumeUsdc ?? 0n),
      protocolFeesClaimed: row.protocolFeesClaimed + (patch.protocolFeesClaimed ?? 0n),
      creatorFeesClaimed: row.creatorFeesClaimed + (patch.creatorFeesClaimed ?? 0n),
    }));
}

ponder.on("Markets:MarketLaunched", async ({ event, context }) => {
  const { id, token, creator, name, symbol } = event.args;

  // Reserves start at the virtual floor; the launch buy lands as its own Bought event
  // in the same transaction and updates them there.
  await context.db.insert(market).values({
    id,
    token,
    creator,
    name,
    symbol,
    reserveUsdc: 125_000_000n,
    reserveToken: 1_000_000_000_000_000n,
    volumeUsdc: 0n,
    tradeCount: 0,
    creatorFeesAccrued: 0n,
    creatorFeesClaimed: 0n,
    createdAtBlock: event.block.number,
    createdAtTx: event.transaction.hash,
  });

  await touchAccount(context.db, creator, event.block.number, { marketsCreated: 1 });
  await bumpStats(context.db, { marketCount: 1 });
});

ponder.on("Markets:Bought", async ({ event, context }) => {
  const { id, buyer, usdcIn, tokensOut, impactBps, reserveUsdc, reserveToken } = event.args;

  await context.db.insert(trade).values({
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    marketId: id,
    trader: buyer,
    side: "buy",
    usdc: usdcIn,
    tokens: tokensOut,
    impactBps,
    reserveUsdcAfter: reserveUsdc,
    reserveTokenAfter: reserveToken,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });

  const fee = (usdcIn * TOTAL_FEE_BPS) / 10_000n;
  const row = await context.db.find(market, { id });
  const isSelfTrade = row !== null && row.creator.toLowerCase() === buyer.toLowerCase();
  const creatorCut = isSelfTrade ? 0n : (fee * CREATOR_FEE_BPS) / TOTAL_FEE_BPS;

  await context.db.update(market, { id }).set((m) => ({
    reserveUsdc,
    reserveToken,
    volumeUsdc: m.volumeUsdc + usdcIn,
    tradeCount: m.tradeCount + 1,
    creatorFeesAccrued: m.creatorFeesAccrued + creatorCut,
  }));

  await touchAccount(context.db, buyer, event.block.number, {
    tradeCount: 1,
    buyVolumeUsdc: usdcIn,
  });
  if (creatorCut > 0n && row !== null) {
    await touchAccount(context.db, row.creator, event.block.number, {
      creatorFeesEarned: creatorCut,
    });
  }
  await bumpStats(context.db, { tradeCount: 1, volumeUsdc: usdcIn });
});

ponder.on("Markets:Sold", async ({ event, context }) => {
  const { id, seller, tokensIn, usdcOut, impactBps, reserveUsdc, reserveToken } = event.args;

  await context.db.insert(trade).values({
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    marketId: id,
    trader: seller,
    side: "sell",
    usdc: usdcOut,
    tokens: tokensIn,
    impactBps,
    reserveUsdcAfter: reserveUsdc,
    reserveTokenAfter: reserveToken,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });

  // The seller receives usdcOut net of fee; the fee itself is fee = gross - usdcOut,
  // and gross is not emitted. Reconstruct: usdcOut = gross * (1 - f) so
  // gross = usdcOut * 10000 / (10000 - TOTAL_FEE_BPS), rounded the contract's way.
  const gross = (usdcOut * 10_000n) / (10_000n - TOTAL_FEE_BPS);
  const fee = gross - usdcOut;
  const row = await context.db.find(market, { id });
  const isSelfTrade = row !== null && row.creator.toLowerCase() === seller.toLowerCase();
  const creatorCut = isSelfTrade ? 0n : (fee * CREATOR_FEE_BPS) / TOTAL_FEE_BPS;

  await context.db.update(market, { id }).set((m) => ({
    reserveUsdc,
    reserveToken,
    volumeUsdc: m.volumeUsdc + usdcOut,
    tradeCount: m.tradeCount + 1,
    creatorFeesAccrued: m.creatorFeesAccrued + creatorCut,
  }));

  await touchAccount(context.db, seller, event.block.number, {
    tradeCount: 1,
    sellVolumeUsdc: usdcOut,
  });
  if (creatorCut > 0n && row !== null) {
    await touchAccount(context.db, row.creator, event.block.number, {
      creatorFeesEarned: creatorCut,
    });
  }
  await bumpStats(context.db, { tradeCount: 1, volumeUsdc: usdcOut });
});

ponder.on("Markets:CreatorFeesClaimed", async ({ event, context }) => {
  const { id, creator, amount } = event.args;

  await context.db.insert(feeClaim).values({
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    kind: "creator",
    marketId: id,
    to: creator,
    amount,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });

  await context.db.update(market, { id }).set((m) => ({
    creatorFeesClaimed: m.creatorFeesClaimed + amount,
  }));
  await bumpStats(context.db, { creatorFeesClaimed: amount });
});

ponder.on("Markets:ProtocolFeesClaimed", async ({ event, context }) => {
  const { to, amount } = event.args;

  await context.db.insert(feeClaim).values({
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    kind: "protocol",
    marketId: null,
    to,
    amount,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });

  await bumpStats(context.db, { protocolFeesClaimed: amount });
});
