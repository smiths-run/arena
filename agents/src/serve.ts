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
import { verifyMessage } from "viem";
import { fullRoster, resolve } from "./roster.ts";
import { createUserAgent } from "./agent-factory.ts";
import { handleAvailable } from "./identity.ts";
import { RESERVED_NAMES } from "./visitor-strategy.ts";
import { equityOf } from "./equity.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

const HANDLE_RE = /^[a-z][a-z0-9-]{2,15}$/;

/** Map internal facts to the public product state. */
function publicState(row: { state: string; name: string }): string {
  if (row.state !== "active") return row.state;
  return store.isPaused(row.name) ? "paused" : "running";
}

/** Per-action wallet auth: a fresh signature over an explicit message. */
async function verifyOwnerAction(
  body: Record<string, unknown>,
  action: string,
  handle: string,
  expectedOwner: string,
): Promise<string | null> {
  if (typeof body.owner !== "string" || typeof body.signature !== "string") {
    return "missing owner or signature";
  }
  if (body.owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    return "not this agent's operator";
  }
  const ts = Number(body.ts ?? 0);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) {
    return "stale request — sign again";
  }
  const ok = await verifyMessage({
    address: body.owner as `0x${string}`,
    message: `Smiths Run: ${action} @${handle} ${ts}`,
    signature: body.signature as `0x${string}`,
  }).catch(() => false);
  return ok ? null : "signature does not verify";
}

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

  // Handle availability — a convenience mirror; the contract is the authority.
  if (req.method === "GET" && url.pathname.startsWith("/handles/")) {
    const handle = decodeURIComponent(url.pathname.slice("/handles/".length)).toLowerCase();
    const valid = HANDLE_RE.test(handle);
    const reserved = RESERVED_NAMES.has(handle);
    let available = false;
    if (valid && !reserved && !store.userAgentByName(handle)) {
      available = await handleAvailable(handle).catch(() => false);
    }
    return json(res, { handle, valid, available, reserved });
  }

  // The operator's one agent, by owner address.
  if (req.method === "GET" && url.pathname === "/agent/status") {
    const owner = (url.searchParams.get("owner") ?? "").toLowerCase();
    const row = owner ? store.userAgentByOwner(owner) : undefined;
    if (!row) return json(res, { exists: false });
    return json(res, {
      exists: true,
      handle: row.name,
      state: publicState(row),
      wallet: row.address,
      agentId: row.agent_id,
      cashUsdc: (await balanceOf(row.address)) ?? "0",
      activationMinimumUsdc: "2000000",
    });
  }

  // One aggregate for the Run screen: identity, economics, positions, decisions.
  if (req.method === "GET" && url.pathname === "/run/overview") {
    const owner = (url.searchParams.get("owner") ?? "").toLowerCase();
    const row = owner ? store.userAgentByOwner(owner) : undefined;
    if (!row) return json(res, { exists: false });
    const entry = resolve(row.name);
    if (!entry) return json(res, { exists: false });

    let equity: Awaited<ReturnType<typeof equityOf>> | null = null;
    try {
      equity = await equityOf(row.name, row.address as `0x${string}`);
    } catch {
      equity = null;
    }

    const positions = [];
    for (const p of store.positionsOf(row.name)) {
      if (p.tokens <= 0n) continue;
      let value: bigint | null = null;
      try {
        value = (await obs.quoteSell(p.marketId, p.tokens)).usdcOut;
      } catch {
        value = null;
      }
      positions.push({
        marketId: p.marketId.toString(),
        tokens: p.tokens.toString(),
        costUsdc: p.costUsdc.toString(),
        valueUsdc: value?.toString() ?? null,
      });
    }

    const decisions = (store.db
      .prepare("SELECT * FROM runs WHERE agent = ? ORDER BY id DESC LIMIT 12")
      .all(row.name) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id,
      at: r.finished_at ?? r.started_at,
      outcome: r.outcome,
      action: r.action_kind,
      marketId: r.market_id,
      usdc: r.usdc,
      reason: String(r.reason ?? "").split("\n")[0].slice(0, 160),
      txHash: r.tx_hash,
      signed: Boolean(r.receipt_signature),
      netResult:
        r.equity_open && r.equity_close
          ? (BigInt(r.equity_close as string) - BigInt(r.equity_open as string)).toString()
          : null,
    }));

    const risk =
      entry.strategy.maxTradeUsdc <= 500_000n
        ? "low"
        : entry.strategy.maxTradeUsdc >= 2_000_000n
          ? "high"
          : "balanced";

    return json(res, {
      exists: true,
      agent: {
        handle: row.name,
        agentId: row.agent_id,
        wallet: row.address,
        approach: entry.approach,
        risk,
        mandate: entry.mandate,
        state: publicState(row),
        identityTx: row.identity_tx,
        handleTx: row.handle_tx,
      },
      economics: {
        equity: equity?.total?.toString() ?? null,
        cash: equity?.walletUsdc?.toString() ?? (await balanceOf(row.address)),
        netResult: store.netResultByAgent().find((n) => n.agent === row.name)?.net ?? "0",
        positionCount: positions.length,
        claimableFees: equity?.claimableCreatorFees?.toString() ?? null,
      },
      positions,
      recentDecisions: decisions,
    });
  }

  // Operator controls: per-action wallet signature, no accounts anywhere.
  if (req.method === "POST" && (url.pathname === "/agent/pause" || url.pathname === "/agent/resume")) {
    const body = await readJson(req);
    const owner = typeof body.owner === "string" ? body.owner.toLowerCase() : "";
    const row = owner ? store.userAgentByOwner(owner) : undefined;
    if (!row) return json(res, { error: "this wallet controls no agent" }, 404);
    const action = url.pathname === "/agent/pause" ? "pause" : "resume";
    const err = await verifyOwnerAction(body, action, row.name, row.owner ?? "");
    if (err) return json(res, { error: err }, 403);
    store.setPaused(row.name, action === "pause");
    return json(res, { handle: row.name, state: publicState(row) });
  }

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
        approach: a.approach,
        state: a.kind === "visitor" ? publicState({ state: a.state, name: a.name }) : "running",
        agentId: a.agentId?.toString() ?? null,
        mandate: a.mandate,
        mission: a.mandate,
        owner: a.owner,
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
