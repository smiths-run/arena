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
import { APPROACHES, RESERVED_NAMES, RISKS, deserializeStrategy, serializeStrategy, type Approach } from "./visitor-strategy.ts";
import { confirmationHash, handleChatMessage, pendingView, reviveAction } from "./chat.ts";
import { executeOperatorAction } from "./operator.ts";
import type { PolicyConflict } from "./policy.ts";
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

/**
 * A short memory for answers that cost chain reads.
 *
 * The Run screen polls every few seconds, per agent, and each answer needs an
 * equity snapshot and a quote per position. Those reads are paced — the
 * endpoints rate-limit per caller — so without this the requests queued faster
 * than they drained and the screen sat on "Loading your agents…" forever while
 * every request waited behind the last. Serving a few-second-old answer is the
 * difference between a live screen and no screen.
 */
/** The last chain snapshot that succeeded, kept so a hiccup reads as stale
    rather than as an economy with nothing in it. */
let lastGoodChain: { markets: obs.MarketView[]; flow: obs.TradeView[]; at: number } | null = null;

const answers = new Map<string, { at: number; value: unknown }>();
const ANSWER_TTL_MS = 20_000;

async function cached<T>(key: string, make: () => Promise<T>): Promise<T> {
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < ANSWER_TTL_MS) return hit.value as T;
  const value = await make();
  answers.set(key, { at: Date.now(), value });
  return value;
}


/** Verify a pilot grant (the browser tab's 24h authority) for a given owner. */
async function verifyPilotGrant(
  body: Record<string, unknown>,
  expectedOwner: string,
): Promise<string | null> {
  const owner = typeof body.owner === "string" ? body.owner.toLowerCase() : "";
  const expiry = Number(body.expiry ?? 0);
  if (owner !== expectedOwner.toLowerCase()) return "not this agent's operator";
  if (!Number.isFinite(expiry) || expiry < Date.now()) return "pilot grant expired — sign again";
  const ok = await verifyMessage({
    address: body.owner as `0x${string}`,
    message: `Smiths Run: pilot ${owner} until ${expiry}`,
    signature: body.signature as `0x${string}`,
  }).catch(() => false);
  return ok ? null : "pilot signature does not verify";
}

/** The operator's agent by handle, or their first. Row is undefined if none. */
function ownedAgent(owner: string, handle: string): store.UserAgentRow | undefined {
  const mine = owner ? store.userAgentsListByOwner(owner.toLowerCase()) : [];
  const wanted = handle.toLowerCase();
  return wanted ? mine.find((r) => r.name === wanted) : mine[0];
}

/**
 * Apply a confirmed change. One implementation serves both paths — the Rules
 * panel signing the exact mutation, and chat confirming an LLM proposal — so
 * there is exactly one place where configuration actually moves.
 */
function applyChange(row: store.UserAgentRow, type: string, payload: Record<string, unknown>): string {
  if (type === "pause") {
    store.setPaused(row.name, true);
    return "autonomous trading paused";
  }
  if (type === "resume") {
    store.setPaused(row.name, false);
    return "autonomous trading resumed";
  }
  if (type === "rule_add") {
    const text = String(payload.text ?? "").slice(0, store.MAX_RULE_LENGTH);
    if (!text) throw new Error("a rule needs text");
    if (store.rulesOf(row.name).length >= store.MAX_RULES_PER_AGENT) {
      throw new Error(`rule limit reached (${store.MAX_RULES_PER_AGENT})`);
    }
    store.ruleAdd(row.name, text);
    return `rule added: "${text}"`;
  }
  if (type === "rule_edit") {
    const text = String(payload.text ?? "").slice(0, store.MAX_RULE_LENGTH);
    if (!store.ruleEdit(row.name, Number(payload.ruleId), text)) throw new Error("no such rule");
    return "rule updated";
  }
  if (type === "rule_delete") {
    if (!store.ruleDelete(row.name, Number(payload.ruleId))) throw new Error("no such rule");
    return "rule removed";
  }
  if (type === "rule_toggle") {
    if (!store.ruleSetEnabled(row.name, Number(payload.ruleId), payload.enabled === true)) {
      throw new Error("no such rule");
    }
    return payload.enabled === true ? "rule enabled" : "rule disabled";
  }
  if (type === "mandate") {
    const mandate = String(payload.mandate ?? "").slice(0, 280);
    store.userAgentSetMandate(row.name, mandate || null);
    return "mandate updated";
  }
  if (type === "approach") {
    const v = String(payload.approach ?? "");
    if (!APPROACHES.includes(v as Approach)) throw new Error("invalid approach");
    store.userAgentSetApproach(row.name, v);
    return `approach is now ${v}`;
  }
  if (type === "risk") {
    const v = String(payload.risk ?? "") as keyof typeof RISKS;
    const preset = RISKS[v];
    if (!preset) throw new Error("invalid risk");
    // The preset rewrites exactly the numbers Risk owns; everything else the
    // strategy carries (launch names, cooldown, llm budget) stays as it was.
    const strategy = deserializeStrategy(row.strategy);
    strategy.maxTradeUsdc = preset.maxTradeUsdc;
    strategy.takeProfitBps = preset.takeProfitBps;
    strategy.stopLossBps = preset.stopLossBps;
    strategy.minExternalTrades = preset.minExternalTrades;
    store.userAgentSetStrategy(row.name, serializeStrategy(strategy));
    return `risk is now ${v}`;
  }
  throw new Error(`unknown change type ${type}`);
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

    // The chain reads for this agent, memoised for a few seconds. The screen
    // polls faster than these can be fetched, and a queue that grows forever
    // is a screen that never loads.
    const priced = await cached(`overview:${row.name}`, async () => {
      let equity: Awaited<ReturnType<typeof equityOf>> | null = null;
      try {
        equity = await equityOf(row.name, row.address as `0x${string}`);
      } catch {
        equity = null;
      }

      // The equity snapshot already quoted every position; quoting them again
      // here doubled the chain reads behind the slowest screen on the site.
      const held: Array<{ marketId: string; tokens: string; costUsdc: string; valueUsdc: string | null }> = [];
      for (const p of store.positionsOf(row.name)) {
        if (p.tokens <= 0n) continue;
        const value = equity?.positionValues.get(p.marketId.toString()) ?? null;
        held.push({
          marketId: p.marketId.toString(),
          tokens: p.tokens.toString(),
          costUsdc: p.costUsdc.toString(),
          valueUsdc: value?.toString() ?? null,
        });
      }
      return { equity, held };
    });

    const equity = priced.equity;
    const positions = priced.held;

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
    // A momentary failure here — a saturated queue, an endpoint refusing —
    // must not be reported as an empty economy. The last good answer is far
    // closer to the truth than zero, and the caller is told it is stale.
    let markets: obs.MarketView[];
    let flow: obs.TradeView[];
    try {
      [markets, flow] = await Promise.all([obs.fetchMarkets(), obs.fetchRecentTrades()]);
      lastGoodChain = { markets, flow, at: Date.now() };
    } catch (err) {
      if (!lastGoodChain) throw err;
      markets = lastGoodChain.markets;
      flow = lastGoodChain.flow;
    }
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
        token: m.token,
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
      // How old this answer is. Zero when it was just read from the chain.
      staleForMs: lastGoodChain ? Date.now() - lastGoodChain.at : 0,
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
        // When this agent last actually ran. A visitor agent only runs while
        // its operator's tab is flying it, so "active" and "running right now"
        // are different claims and the page must be able to tell them apart.
        lastRunAt: store.lastRunAt(a.name),
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


  // ── the living-agent surface: chat, rules, confirmations ──────────────────

  if (req.method === "GET" && url.pathname === "/chat/history") {
    const owner = (url.searchParams.get("owner") ?? "").toLowerCase();
    const row = ownedAgent(owner, url.searchParams.get("handle") ?? "");
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);
    const active = store.confirmationActive(row.name);
    return json(res, {
      messages: store.chatHistory(row.name, 40),
      pending: active ? pendingView(active) : null,
      budget: { used: store.chatOperatorMessagesLast24h(row.name), max: 40 },
    });
  }

  // Talking is read-level: the pilot grant that flies the agent also lets its
  // operator speak to it. Anything the conversation proposes still needs a
  // fresh signature to happen.
  if (req.method === "POST" && url.pathname === "/chat/message") {
    const body = await readJson(req);
    const row = ownedAgent(String(body.owner ?? ""), String(body.handle ?? ""));
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);
    const authErr = await verifyPilotGrant(body, row.owner ?? "");
    if (authErr) return json(res, { error: authErr }, 403);
    const message = String(body.message ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000);
    if (!message) return json(res, { error: "empty message" }, 400);
    const entry = resolve(row.name);
    if (!entry) return json(res, { error: "agent is not active yet" }, 409);
    const outcome = await handleChatMessage(entry, row, message);
    return json(res, outcome);
  }

  // The signature IS the confirmation: it covers the confirmation id and a
  // hash of the exact proposal, so what executes is what was shown.
  if (req.method === "POST" && url.pathname === "/chat/confirm") {
    const body = await readJson(req);
    const row = ownedAgent(String(body.owner ?? ""), String(body.handle ?? ""));
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);
    const id = Number(body.id ?? 0);
    const active = store.confirmationActive(row.name);
    if (!active || active.id !== id) {
      return json(res, { error: "that proposal is gone — it expired or was replaced" }, 409);
    }
    const hash = confirmationHash(active.payload, active.summary);
    const err = await verifyOwnerAction(body, `confirm #${id} ${hash}`, row.name, row.owner ?? "");
    if (err) return json(res, { error: err }, 403);
    const consumed = store.confirmationConsume(row.name, id);
    if (!consumed) return json(res, { error: "already handled" }, 409);

    let result: string;
    let txHash: string | null = null;
    try {
      if (consumed.type === "action") {
        const entry = resolve(row.name);
        if (!entry) throw new Error("agent is not active");
        const conflicts = consumed.conflicts
          ? (JSON.parse(consumed.conflicts) as PolicyConflict[])
          : [];
        pilotClient ??= circle();
        const r = await executeOperatorAction(pilotClient, entry, reviveAction(consumed.payload), conflicts, id);
        txHash = r.txHash ?? null;
        result =
          r.outcome === "acted"
            ? `done — ${r.detail}`
            : r.outcome === "rejected"
              ? `refused — ${r.detail}`
              : `failed — ${r.detail}`;
      } else {
        result = applyChange(row, consumed.type, JSON.parse(consumed.payload) as Record<string, unknown>);
      }
    } catch (e) {
      result = `failed — ${e instanceof Error ? e.message : String(e)}`;
    }
    store.chatAdd(row.name, "agent", `[confirmed #${id}] ${result}`);
    return json(res, { result, txHash });
  }

  if (req.method === "POST" && url.pathname === "/chat/cancel") {
    const body = await readJson(req);
    const row = ownedAgent(String(body.owner ?? ""), String(body.handle ?? ""));
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);
    const authErr = await verifyPilotGrant(body, row.owner ?? "");
    if (authErr) return json(res, { error: authErr }, 403);
    const id = Number(body.id ?? 0);
    const consumed = store.confirmationConsume(row.name, id);
    if (consumed) store.chatAdd(row.name, "agent", `[cancelled #${id}] ${consumed.summary}`);
    return json(res, { cancelled: Boolean(consumed) });
  }

  if (req.method === "GET" && url.pathname === "/rules") {
    const owner = (url.searchParams.get("owner") ?? "").toLowerCase();
    const row = ownedAgent(owner, url.searchParams.get("handle") ?? "");
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);
    return json(res, {
      rules: store.rulesOf(row.name).map((r) => ({
        id: r.id,
        text: r.text,
        enabled: r.enabled === 1,
      })),
      mandate: row.mission,
      approach: row.approach,
    });
  }

  // Panel mutations: the wallet signs the exact mutation, no LLM in the path.
  if (req.method === "POST" && url.pathname.startsWith("/rules/")) {
    const body = await readJson(req);
    const row = ownedAgent(String(body.owner ?? ""), String(body.handle ?? ""));
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);

    const op = url.pathname.slice("/rules/".length);
    let type: string;
    let payload: Record<string, unknown>;
    let actionMsg: string;
    if (op === "add") {
      const text = String(body.text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, store.MAX_RULE_LENGTH);
      type = "rule_add"; payload = { text };
      actionMsg = `rule add ${confirmationHash(text, text)}`;
    } else if (op === "delete") {
      type = "rule_delete"; payload = { ruleId: Number(body.id ?? 0) };
      actionMsg = `rule delete #${Number(body.id ?? 0)}`;
    } else if (op === "toggle") {
      type = "rule_toggle"; payload = { ruleId: Number(body.id ?? 0), enabled: body.enabled === true };
      actionMsg = `rule toggle #${Number(body.id ?? 0)} ${body.enabled === true ? "on" : "off"}`;
    } else {
      return json(res, { error: "not found" }, 404);
    }
    const err = await verifyOwnerAction(body, actionMsg, row.name, row.owner ?? "");
    if (err) return json(res, { error: err }, 403);
    try {
      return json(res, { result: applyChange(row, type, payload) });
    } catch (e) {
      return json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  if (req.method === "POST" && url.pathname === "/agent/set") {
    const body = await readJson(req);
    const row = ownedAgent(String(body.owner ?? ""), String(body.handle ?? ""));
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);
    const field = String(body.field ?? "");
    const value = String(body.value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!["mandate", "approach", "risk"].includes(field)) return json(res, { error: "unknown field" }, 400);
    const actionMsg =
      field === "mandate" ? `set mandate ${confirmationHash(value, value)}` : `set ${field} ${value.toLowerCase()}`;
    const err = await verifyOwnerAction(body, actionMsg, row.name, row.owner ?? "");
    if (err) return json(res, { error: err }, 403);
    try {
      const payload =
        field === "mandate" ? { mandate: value } : field === "approach" ? { approach: value.toLowerCase() } : { risk: value.toLowerCase() };
      return json(res, { result: applyChange(row, field, payload) });
    } catch (e) {
      return json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
    }
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
