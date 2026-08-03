import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { and, desc, eq, graphql } from "ponder";

/**
 * Public read API. Everything an agent, the arena UI, or a self-hosted participant
 * needs to observe the markets.
 *
 * Amounts are serialized as strings of 6-decimal base units, ordering is always
 * (blockNumber, logIndex), and market ids are plain integers.
 */
const app = new Hono();

/** JSON with bigints stringified — one place, applied everywhere. */
const json = (c: any, value: unknown, status = 200) =>
  c.newResponse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    status,
    { "content-type": "application/json; charset=utf-8" },
  );

app.get("/api/health", (c) => json(c, { ok: true, chainId: 5042002 }));

app.get("/api/stats", async (c) => {
  const rows = await db.select().from(schema.stats).limit(1);
  return json(
    c,
    rows[0] ?? {
      id: 0,
      marketCount: 0,
      tradeCount: 0,
      volumeUsdc: "0",
      protocolFeesClaimed: "0",
      creatorFeesClaimed: "0",
    },
  );
});

app.get("/api/markets", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const rows = await db
    .select()
    .from(schema.market)
    .orderBy(desc(schema.market.createdAtBlock))
    .limit(limit);
  return json(c, { markets: rows });
});

app.get("/api/markets/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const rows = await db.select().from(schema.market).where(eq(schema.market.id, id)).limit(1);
  if (rows.length === 0) return json(c, { error: "market not found" }, 404);
  return json(c, rows[0]);
});

app.get("/api/markets/:id/trades", async (c) => {
  const id = BigInt(c.req.param("id"));
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const rows = await db
    .select()
    .from(schema.trade)
    .where(eq(schema.trade.marketId, id))
    .orderBy(desc(schema.trade.blockNumber), desc(schema.trade.logIndex))
    .limit(limit);
  return json(c, { trades: rows });
});

/** The public feed: every trade, newest first. */
app.get("/api/activity", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const rows = await db
    .select()
    .from(schema.trade)
    .orderBy(desc(schema.trade.blockNumber), desc(schema.trade.logIndex))
    .limit(limit);
  return json(c, { activity: rows });
});

app.get("/api/accounts/:address", async (c) => {
  const address = c.req.param("address").toLowerCase() as `0x${string}`;
  const rows = await db
    .select()
    .from(schema.account)
    .where(eq(schema.account.address, address))
    .limit(1);
  if (rows.length === 0) return json(c, { error: "account not found" }, 404);

  const trades = await db
    .select()
    .from(schema.trade)
    .where(eq(schema.trade.trader, address))
    .orderBy(desc(schema.trade.blockNumber), desc(schema.trade.logIndex))
    .limit(50);

  return json(c, { account: rows[0], recentTrades: trades });
});

/** Registered identities, newest first, with each owner's trading rollup if any. */
app.get("/api/agents", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const rows = await db
    .select()
    .from(schema.agent)
    .orderBy(desc(schema.agent.registeredAtBlock))
    .limit(limit);

  const withStats = await Promise.all(
    rows.map(async (a) => {
      const acct = await db
        .select()
        .from(schema.account)
        .where(eq(schema.account.address, a.owner))
        .limit(1);
      return { ...a, account: acct[0] ?? null };
    }),
  );
  return json(c, { agents: withStats });
});

/** GraphQL for anyone who wants shaped queries; REST stays the primary surface. */
app.use("/graphql", graphql({ db, schema }));

export default app;
