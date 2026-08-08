/**
 * Read-only receipts API over the worker's run ledger.
 *
 *   npm run serve        # http://localhost:42070
 *
 * This is the "public receipt" surface: every run — acted, skipped, rejected or
 * errored — with its reason. Plain node:http, zero dependencies; the web arena
 * proxies to it so the receipts sit next to the market data.
 */
import { createServer, type IncomingMessage } from "node:http";
import { fullRoster } from "./roster.ts";
import { createUserAgent } from "./agent-factory.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

// Wallet balances for the roster listing: one RPC read per agent, cached 30s,
// and a failure shows as null rather than taking the listing down.
const balances = new Map<string, { v: string | null; at: number }>();
async function balanceOf(address: string): Promise<string | null> {
  const hit = balances.get(address);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  let v: string | null = null;
  try {
    v = (await obs.walletUsdc(address as `0x${string}`)).toString();
  } catch {
    v = hit?.v ?? null;
  }
  balances.set(address, { v, at: Date.now() });
  return v;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const PORT = Number(process.env.RECEIPTS_PORT ?? 42070);

const json = (res: import("node:http").ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") return json(res, { ok: true });

  // Visitor agent creation: the one write this surface accepts. Everything a
  // visitor can influence is clamped in visitor-strategy.ts; everything the
  // agent later does still passes the policy engine.
  if (req.method === "POST" && url.pathname === "/agents/create") {
    if (req.method !== "POST") return json(res, { error: "POST only" }, 405);
    try {
      const body = await readJson(req);
      const ip =
        (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
        req.socket.remoteAddress ??
        null;
      const created = await createUserAgent(body, ip);
      return json(res, created, 201);
    } catch (err) {
      return json(res, { error: err instanceof Error ? err.message : "creation failed" }, 400);
    }
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  if (url.pathname === "/runs") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
    const agentName = url.searchParams.get("agent");
    const rows = agentName
      ? store.db
          .prepare("SELECT * FROM runs WHERE agent = ? ORDER BY id DESC LIMIT ?")
          .all(agentName, limit)
      : store.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit);
    return json(res, { runs: rows });
  }

  if (url.pathname === "/agents") {
    const rows = await Promise.all(fullRoster().map(async (a) => {
      const outcomes = store.db
        .prepare("SELECT outcome, COUNT(*) n FROM runs WHERE agent = ? GROUP BY outcome")
        .all(a.name) as Array<{ outcome: string; n: number }>;
      const positions = store.positionsOf(a.name).map((p) => ({
        marketId: p.marketId.toString(),
        tokens: p.tokens.toString(),
        costUsdc: p.costUsdc.toString(),
      }));
      const totals = store.intelTotals();
      const bought = totals.bought.find((b) => b.buyer.toLowerCase() === a.address.toLowerCase());
      const sold = totals.sold.find((s) => s.seller.toLowerCase() === a.address.toLowerCase());
      return {
        name: a.name,
        address: a.address,
        kind: a.kind,
        symbol: a.strategy.launchNames?.[0]?.symbol ?? null,
        mission: a.kind === "visitor" ? (store.userAgentByName(a.name)?.mission ?? null) : null,
        owner: a.kind === "visitor" ? (store.userAgentByName(a.name)?.owner ?? null) : null,
        walletUsdc: await balanceOf(a.address),
        spent24h: store.spentLast24h(a.name).toString(),
        outcomes: Object.fromEntries(outcomes.map((o) => [o.outcome, o.n])),
        positions,
        intelBoughtCount: bought?.count ?? 0,
        intelSpent: String(bought?.total ?? "0"),
        intelSoldCount: sold?.count ?? 0,
        intelEarned: String(sold?.total ?? "0"),
        netResult: store.netResultByAgent().find((n) => n.agent === a.name)?.net ?? "0",
      };
    }));
    return json(res, { agents: rows });
  }

  if (url.pathname === "/net-result") {
    return json(res, { agents: store.netResultByAgent() });
  }

  if (url.pathname === "/intel") {
    const purchases = store.db
      .prepare("SELECT * FROM intel_purchases ORDER BY id DESC LIMIT 50")
      .all();
    const sales = store.db.prepare("SELECT * FROM intel_sales ORDER BY id DESC LIMIT 50").all();
    return json(res, { purchases, sales, totals: store.intelTotals() });
  }

  json(res, { error: "not found" }, 404);
});

server.listen(PORT, () => {
  console.log(`receipts api on http://localhost:${PORT}`);
});
