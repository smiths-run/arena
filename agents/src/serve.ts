/**
 * Read-only receipts API over the worker's run ledger.
 *
 *   npm run serve        # http://localhost:42070
 *
 * This is the "public receipt" surface: every run — acted, skipped, rejected or
 * errored — with its reason. Plain node:http, zero dependencies; the web arena
 * proxies to it so the receipts sit next to the market data.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { verifyMessage } from "viem";
import { fullRoster, resolve } from "./roster.ts";
import { createUserAgent } from "./agent-factory.ts";
import { handleAvailable } from "./identity.ts";
import { RESERVED_NAMES } from "./visitor-strategy.ts";
import { equityOf } from "./equity.ts";
import { runOnce } from "./runtime.ts";
import { historyStatus } from "./history.ts";
import { decide } from "./schedule.ts";
import { heuristicStrategist } from "./strategist.ts";
import { llmStrategist } from "./llm-strategist.ts";
import { circle } from "./shared.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

// The pilot lane: one Circle client for tick-driven runs, one in-flight guard
// per agent so two tabs can never fly the same agent into itself.
let pilotClient: ReturnType<typeof circle> | null = null;
const ticking = new Set<string>();

const HANDLE_RE = /^[a-z][a-z0-9-]{2,15}$/;

/** The activation bar, mirrored from the orchestrator so the two agree. */
const ACTIVATION_MINIMUM = 2_000_000n;

/**
 * What to call an agent's state out loud.
 *
 * Funding and activation are separate moments: the money arrives instantly,
 * the sweep that registers the identity and claims the handle runs on its own
 * cadence. In between, an agent holding five USDC was being told it was
 * "waiting for capital, it needs at least 2" — true of the stored state,
 * plainly false to the person who had just paid. Given the balance, say what
 * is actually happening.
 */
function publicState(row: { state: string; name: string }, cash?: string | bigint | null): string {
  if (row.state === "awaiting_funding" && cash != null && BigInt(cash) >= ACTIVATION_MINIMUM) {
    return "activating";
  }
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

/**
 * One request, handled. Anything it throws is caught by the server below
 * rather than escaping: an async handler that rejects is an unhandled
 * rejection, which ends the process — and since all three agent processes
 * share a container, one rate-limited balance read inside one request was
 * taking the whole economy down and restarting it every few minutes.
 */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  // The operator's fleet: every agent this wallet runs, with quick stats.
  if (req.method === "GET" && url.pathname === "/my/agents") {
    const owner = (url.searchParams.get("owner") ?? "").toLowerCase();
    if (!owner) return json(res, { agents: [] });
    const net = store.netResultByAgent();
    const rows = await Promise.all(
      store.userAgentsListByOwner(owner).map(async (r) => {
        const cashUsdc = await balanceOf(r.address);
        return {
          handle: r.name,
          state: publicState(r, cashUsdc),
          approach: r.approach,
          agentId: r.agent_id,
          wallet: r.address,
          cashUsdc,
          netResult: net.find((n) => n.agent === r.name)?.net ?? "0",
          positions: store.positionsOf(r.name).filter((p) => p.tokens > 0n).length,
        };
      }),
    );
    return json(res, { agents: rows });
  }

  // The operator's first agent, by owner address (legacy single-agent shape).
  if (req.method === "GET" && url.pathname === "/agent/status") {
    const owner = (url.searchParams.get("owner") ?? "").toLowerCase();
    const row = owner ? store.userAgentByOwner(owner) : undefined;
    if (!row) return json(res, { exists: false });
    return json(res, {
      exists: true,
      handle: row.name,
      state: publicState(row, await balanceOf(row.address)),
      wallet: row.address,
      agentId: row.agent_id,
      cashUsdc: (await balanceOf(row.address)) ?? "0",
      activationMinimumUsdc: "2000000",
    });
  }

  // One aggregate for the Run screen: identity, economics, positions, decisions.
  // `handle` selects within the fleet; without it, the operator's first agent.
  if (req.method === "GET" && url.pathname === "/run/overview") {
    const owner = (url.searchParams.get("owner") ?? "").toLowerCase();
    const wanted = (url.searchParams.get("handle") ?? "").toLowerCase();
    const mine = owner ? store.userAgentsListByOwner(owner) : [];
    const row = wanted ? mine.find((r) => r.name === wanted) : mine[0];
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

    const cash = equity?.walletUsdc?.toString() ?? (await balanceOf(row.address));

    return json(res, {
      exists: true,
      agent: {
        handle: row.name,
        agentId: row.agent_id,
        wallet: row.address,
        approach: entry.approach,
        risk,
        mandate: entry.mandate,
        state: publicState(row, cash),
        identityTx: row.identity_tx,
        handleTx: row.handle_tx,
      },
      economics: {
        equity: equity?.total?.toString() ?? null,
        cash,
        netResult: store.netResultByAgent().find((n) => n.agent === row.name)?.net ?? "0",
        positionCount: positions.length,
        claimableFees: equity?.claimableCreatorFees?.toString() ?? null,
      },
      positions,
      recentDecisions: decisions,
    });
  }

  // The pilot tick: a browser tab flying one of its operator's agents.
  //
  // The platform does not schedule visitor agents — their runs happen only
  // while an operator's tab is open and ticking. Authorization is one wallet
  // signature over an expiring pilot grant, made once and reused silently;
  // custody never moves (Circle signs server-side, policy still disposes).
  if (req.method === "POST" && url.pathname === "/agent/tick") {
    const body = await readJson(req);
    const owner = typeof body.owner === "string" ? body.owner.toLowerCase() : "";
    const wanted = typeof body.handle === "string" ? body.handle.toLowerCase() : "";
    const expiry = Number(body.expiry ?? 0);
    const mine = owner ? store.userAgentsListByOwner(owner) : [];
    const row = mine.find((r) => r.name === wanted);
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);

    if (!Number.isFinite(expiry) || expiry < Date.now() || expiry > Date.now() + 8 * 24 * 3600 * 1000) {
      return json(res, { error: "pilot grant expired — sign again" }, 403);
    }
    const ok = await verifyMessage({
      address: body.owner as `0x${string}`,
      message: `Smiths Run: pilot ${owner} until ${expiry}`,
      signature: body.signature as `0x${string}`,
    }).catch(() => false);
    if (!ok) return json(res, { error: "pilot signature does not verify" }, 403);

    if (row.state !== "active") return json(res, { ran: false, reason: row.state });
    if (ticking.has(row.name)) return json(res, { ran: false, reason: "busy" });

    const entry = resolve(row.name);
    if (!entry) return json(res, { ran: false, reason: "unknown agent" });
    const cooldownMs = entry.strategy.cooldownSeconds * 1000;
    const sinceMs = Date.now() - store.lastRunAt(row.name);
    const verdict = decide({
      held: store.unresolvedPending().some((p) => p.agent === row.name),
      requested: false,
      paused: store.isPaused(row.name),
      once: false,
      sinceLastRunMs: sinceMs,
      cooldownMs,
    });
    if (!verdict.run) {
      return json(res, {
        ran: false,
        reason: verdict.why,
        nextInSeconds: Math.max(0, Math.ceil((cooldownMs - sinceMs) / 1000)),
      });
    }

    ticking.add(row.name);
    try {
      pilotClient ??= circle();
      const strategist =
        entry.strategy.llm.enabled && process.env.ANTHROPIC_API_KEY ? llmStrategist : heuristicStrategist;
      await runOnce(row.name, "pilot", pilotClient, strategist);
    } catch (err) {
      // runOnce records its own failures as runs; anything that still escapes
      // must not take the server down with it.
      const msg = err instanceof Error ? err.message : String(err);
      return json(res, { ran: false, reason: "error", error: msg.slice(0, 200) }, 500);
    } finally {
      ticking.delete(row.name);
    }
    const last = store.db
      .prepare("SELECT id, outcome, action_kind, reason FROM runs WHERE agent = ? ORDER BY id DESC LIMIT 1")
      .get(row.name) as { id: number; outcome: string; action_kind: string | null; reason: string | null };
    return json(res, {
      ran: true,
      run: { ...last, reason: (last.reason ?? "").split("\n")[0].slice(0, 160) },
      nextInSeconds: entry.strategy.cooldownSeconds,
    });
  }

  // Operator controls: per-action wallet signature, no accounts anywhere.
  // `handle` addresses one agent in the fleet; default is the first.
  if (req.method === "POST" && (url.pathname === "/agent/pause" || url.pathname === "/agent/resume")) {
    const body = await readJson(req);
    const owner = typeof body.owner === "string" ? body.owner.toLowerCase() : "";
    const mine = owner ? store.userAgentsListByOwner(owner) : [];
    const wanted = typeof body.handle === "string" ? body.handle.toLowerCase() : "";
    const row = wanted ? mine.find((r) => r.name === wanted) : mine[0];
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);
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
    res.end();
    return;
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

  /**
   * The markets, straight from the chain.
   *
   * The indexer is the history surface and it can fall behind; a market that
   * exists is not a matter of opinion. The site's front page asks here so it
   * shows what the chain shows — the same reads the agents use, sharing their
   * cache, so this costs nothing extra.
   */
  if (url.pathname === "/markets") {
    const [markets, flow] = await Promise.all([obs.fetchMarkets(), obs.fetchRecentTrades()]);
    const recentOf = new Map<string, number>();
    for (const t of flow) {
      const key = t.marketId.toString();
      recentOf.set(key, (recentOf.get(key) ?? 0) + 1);
    }
    const history = new Map(store.marketHistory().map((h) => [h.marketId, h]));
    return json(res, {
      markets: markets.map((m) => ({
        id: m.id.toString(),
        symbol: m.symbol,
        name: m.name,
        creator: m.creator,
        reserveUsdc: m.reserveUsdc.toString(),
        recentTrades: recentOf.get(m.id.toString()) ?? 0,
        // Lifetime totals, as far as the history walk has read. Null until it
        // has passed this market's launch, so the page can say "not yet"
        // instead of "zero".
        volumeUsdc: history.get(m.id.toString())?.volumeUsdc ?? null,
        tradeCount: history.get(m.id.toString())?.tradeCount ?? null,
      })),
      history: historyStatus(),
      // Newest first, the way a reader scans it.
      recentTrades: [...flow]
        .sort((a, b) =>
          a.blockNumber === b.blockNumber
            ? b.logIndex - a.logIndex
            : Number(b.blockNumber - a.blockNumber),
        )
        .slice(0, 20)
        .map((t) => ({
          marketId: t.marketId.toString(),
          symbol: markets.find((m) => m.id === t.marketId)?.symbol ?? "",
          trader: t.trader,
          side: t.side,
          usdc: t.usdc.toString(),
          impactBps: t.impactBps.toString(),
          txHash: t.txHash,
          logIndex: t.logIndex,
          blockNumber: t.blockNumber.toString(),
        })),
    });
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
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${req.method} ${req.url} failed: ${msg}`);
    if (res.headersSent) res.end();
    else json(res, { error: "internal error" }, 500);
  });
});

server.listen(PORT, () => {
  console.log(`receipts api on http://localhost:${PORT}`);
});
