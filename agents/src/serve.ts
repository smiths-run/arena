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
import {
  confirmationHash,
  handleChatMessage,
  pendingView,
  requiresWalletSignature,
  reviveAction,
} from "./chat.ts";
import { executeOperatorAction, executeWithdrawal, withdrawable } from "./operator.ts";
import type { PolicyConflict } from "./policy.ts";
import { equityOf } from "./equity.ts";
import { runOnce } from "./runtime.ts";
import { historyStatus } from "./history.ts";
import { decide } from "./schedule.ts";
import { heuristicStrategist } from "./strategist.ts";
import { llmStrategist } from "./llm-strategist.ts";
import { circle } from "./shared.ts";
import { actorByHandle, nearestHandles } from "./actors.ts";
import * as feed from "./events.ts";
import { createTrigger, describePlan, planTrigger, runPendingFires } from "./triggers.ts";
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

/**
 * The pilot grant, carried on a read.
 *
 * A credential does not belong in a URL: query strings land in server logs,
 * browser history and referrers, so the grant rides headers instead. The owner
 * comes from the header rather than from the query string, which means the
 * address a caller claims and the address they can prove are the same value —
 * there is nothing to disagree about.
 */
async function verifyGrantHeader(
  req: IncomingMessage,
): Promise<{ owner: string } | { error: string }> {
  const owner = String(req.headers["x-smiths-owner"] ?? "").toLowerCase();
  const expiry = Number(req.headers["x-smiths-expiry"] ?? 0);
  const signature = String(req.headers["x-smiths-signature"] ?? "");
  if (!owner || !signature) return { error: "this is private — sign in with your wallet" };
  const err = await verifyPilotGrant({ owner, expiry, signature }, owner);
  return err ? { error: err } : { owner };
}

/**
 * An agent this caller has proved they own.
 *
 * Everything private to an operator goes through here. The alternative — an
 * owner address in the query string and no proof — is not access control at
 * all: the roster publishes every agent's owner, so anyone could have read
 * anyone's private conversation by copying an address off a public page.
 */
async function provenAgent(
  req: IncomingMessage,
  handle: string,
): Promise<{ row: store.UserAgentRow } | { error: string; status: number }> {
  const auth = await verifyGrantHeader(req);
  if ("error" in auth) return { error: auth.error, status: 403 };
  const row = ownedAgent(auth.owner, handle);
  if (!row) return { error: "this wallet controls no such agent", status: 404 };
  return { row };
}

/**
 * Who may change this agent, and with which credential.
 *
 * Two are accepted and they mean different things. The pilot grant is a
 * session: one wallet signature, good for the day, already held by the tab
 * that flies the fleet — so configuring an agent costs no popups. A per-action
 * signature is the fallback for a tab holding no grant, and it stays the only
 * thing accepted where a signature is the point rather than the proof: crossing
 * a limit the operator themselves set (see /chat/confirm).
 *
 * Neither credential reaches the hard layer. Contract caps, the operating
 * reserve, selling more than is held — those refuse a signed request exactly as
 * they refuse an unsigned one.
 */
async function operatorAuth(
  body: Record<string, unknown>,
  row: { name: string; owner?: string | null },
  actionMsg: string,
): Promise<string | null> {
  if (body.expiry !== undefined) return verifyPilotGrant(body, row.owner ?? "");
  return verifyOwnerAction(body, actionMsg, row.name, row.owner ?? "");
}

/** bigints are not JSON; hashing a plan must still be deterministic. */
function bigintSafe(_k: string, v: unknown) {
  return typeof v === "bigint" ? `${v}n` : v;
}

/** A trigger as the operator reads it, with what it has actually done. */
function triggerJson(t: store.TriggerRow) {
  const last = store.firesForTrigger(t.id, 1)[0] ?? null;
  return {
    id: t.id,
    target: t.targetHandle,
    event: t.event,
    mode: t.mode,
    sizing: t.sizing,
    amountUsdc: t.amountUsdc === null ? null : t.amountUsdc.toString(),
    proportionBps: t.proportionBps,
    dailyBudgetUsdc: t.dailyBudgetUsdc.toString(),
    spentTodayUsdc: store.triggerSpent24h(t.id).toString(),
    maxActionUsdc: t.maxActionUsdc.toString(),
    overrideRisk: t.overrideRisk,
    expiresAt: t.expiresAt,
    enabled: t.enabled,
    summary: describePlan({
      targetHandle: t.targetHandle,
      event: t.event,
      mode: t.mode,
      sizing: t.sizing,
      amountUsdc: t.amountUsdc,
      proportionBps: t.proportionBps,
      dailyBudgetUsdc: t.dailyBudgetUsdc,
      maxActionUsdc: t.maxActionUsdc,
      overrideRisk: t.overrideRisk,
      expiresAt: t.expiresAt ?? 0,
    }),
    lastFire: last ? fireJson(last) : null,
  };
}

/** What one trigger did about one event, including doing nothing and why. */
function fireJson(f: store.TriggerFireRow) {
  return {
    id: f.id,
    triggerId: f.triggerId,
    at: f.createdAt,
    handledAt: f.handledAt,
    status: f.status,
    detail: f.detail,
    runId: f.runId,
    usdc: f.usdc,
  };
}

/**
 * An event as JSON. The actor is named where we can name them and reported as
 * an external wallet where we cannot — the reader is never left to guess which.
 */
function eventJson(e: feed.EventView) {
  return {
    id: e.id,
    type: e.type,
    at: e.at,
    blockNumber: e.blockNumber,
    txHash: e.txHash,
    marketId: e.marketId,
    symbol: e.symbol,
    usdc: e.usdc,
    tokens: e.tokens,
    actor: {
      wallet: e.actor.wallet,
      handle: e.actor.handle,
      agentId: e.actor.agentId,
      type: e.actor.kind === "external" ? "external_wallet" : "agent",
    },
    summary: feed.describe(e),
  };
}

/** The operator's agent by handle, or their first. Row is undefined if none. */
function ownedAgent(owner: string, handle: string): store.UserAgentRow | undefined {
  const mine = owner ? store.userAgentsListByOwner(owner.toLowerCase()) : [];
  const wanted = handle.toLowerCase();
  return wanted ? mine.find((r) => r.name === wanted) : mine[0];
}

/**
 * Apply a confirmed change. One implementation serves both paths — the Rules
 * panel naming the exact mutation, and chat confirming an LLM proposal — so
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
  if (type === "trigger_add") {
    // The payload is the plan the operator confirmed, hashed into their
    // signature when it carried an override — so it is stored as agreed rather
    // than re-planned here, where the world may have moved on.
    const plan = payload as unknown as Parameters<typeof createTrigger>[1];
    const id = createTrigger(row.name, plan);
    return `trigger #${id} is live: ${describePlan(plan)}`;
  }
  throw new Error(`unknown change type ${type}`);
}

/**
 * Put the coin's name back into a sentence that was written with its id.
 *
 * A decision is stored once and read for as long as the agent exists, and the
 * ticker may only have been read from the chain afterwards. This is the same
 * market either way — the substitution renames nothing, it just stops the
 * operator from having to remember that market 11 is the one they named.
 */
function named(text: string, tickers: Map<string, string>): string {
  return text.replace(/\bmarket (\d+)\b/g, (whole, id: string) => tickers.get(id) ?? whole);
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
    // The screen shows tickers; the ledger stores ids. One lookup labels both
    // lists, and a market whose name has not been read yet simply has none.
    const tickers = store.marketSymbols();
    const positions = priced.held.map((p) => ({ ...p, symbol: tickers.get(p.marketId) ?? null }));

    const decisions = (store.db
      .prepare("SELECT * FROM runs WHERE agent = ? ORDER BY id DESC LIMIT 12")
      .all(row.name) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id,
      at: r.finished_at ?? r.started_at,
      outcome: r.outcome,
      action: r.action_kind,
      marketId: r.market_id,
      symbol: r.market_id ? (tickers.get(String(r.market_id)) ?? null) : null,
      usdc: r.usdc,
      reason: named(String(r.reason ?? "").split("\n")[0], tickers).slice(0, 160),
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
        // What could leave the wallet right now: everything except the gas it
        // needs to act at all. Offering a "max" that bricks the agent would be
        // a worse answer than offering none.
        withdrawableUsdc: cash === null ? null : withdrawable(BigInt(cash)).toString(),
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

    // The tick itself is the proof of life: an agent counts as awake, and so
    // can be reached by an event, for as long as its operator's tab is here.
    store.markSeen(row.name);

    const entry = resolve(row.name);
    if (!entry) return json(res, { ran: false, reason: "unknown agent" });
    const cooldownMs = entry.strategy.cooldownSeconds * 1000;
    const sinceMs = Date.now() - store.lastRunAt(row.name);
    const pending = store.firesPending(row.name);
    const verdict = decide({
      held: store.unresolvedPending().some((p) => p.agent === row.name),
      requested: false,
      paused: store.isPaused(row.name),
      once: false,
      triggered: pending.length > 0,
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
      if (verdict.trigger === "trigger") {
        // Answering what already happened comes first, and does not spend the
        // agent's own initiative: a reaction is not a scheduled run.
        const handled = await runPendingFires(row.name, pilotClient, strategist, "pilot");
        return json(res, {
          ran: true,
          trigger: "trigger",
          handled,
          nextInSeconds: 2,
        });
      }
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

  // Operator controls: the tab's pilot grant, or a per-action signature when it
  // holds none. No accounts anywhere either way.
  // `handle` addresses one agent in the fleet; default is the first.
  if (req.method === "POST" && (url.pathname === "/agent/pause" || url.pathname === "/agent/resume")) {
    const body = await readJson(req);
    const owner = typeof body.owner === "string" ? body.owner.toLowerCase() : "";
    const mine = owner ? store.userAgentsListByOwner(owner) : [];
    const wanted = typeof body.handle === "string" ? body.handle.toLowerCase() : "";
    const row = wanted ? mine.find((r) => r.name === wanted) : mine[0];
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);
    const action = url.pathname === "/agent/pause" ? "pause" : "resume";
    const err = await operatorAuth(body, row, action);
    if (err) return json(res, { error: err }, 403);
    store.setPaused(row.name, action === "pause");
    return json(res, { handle: row.name, state: publicState(row) });
  }

  /**
   * Take capital back out of an agent.
   *
   * This is the one place money leaves the system, and it is the one action
   * that always takes a fresh wallet signature — no session, no exceptions.
   * A grant is a day-long convenience; a drain is not something a day-old
   * convenience should be able to authorize, and the message the operator
   * signs names the exact amount and the exact destination so what executes
   * is what they read.
   *
   * The destination is not in the request at all. It is the owner on file.
   */
  if (req.method === "POST" && url.pathname === "/agent/withdraw") {
    const body = await readJson(req);
    const owner = typeof body.owner === "string" ? body.owner.toLowerCase() : "";
    const mine = owner ? store.userAgentsListByOwner(owner) : [];
    const wanted = typeof body.handle === "string" ? body.handle.toLowerCase() : "";
    const row = wanted ? mine.find((r) => r.name === wanted) : mine[0];
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);

    const amount = (() => {
      try {
        const raw = String(body.amountUsdc ?? "");
        return /^\d+$/.test(raw) ? BigInt(raw) : null;
      } catch {
        return null;
      }
    })();
    if (amount === null || amount <= 0n) return json(res, { error: "amount must be a positive number of USDC base units" }, 400);

    const err = await verifyOwnerAction(
      body,
      `withdraw ${Number(amount) / 1e6} USDC to ${row.owner}`,
      row.name,
      row.owner ?? "",
    );
    if (err) return json(res, { error: err }, 403);

    const entry = resolve(row.name);
    if (!entry) return json(res, { error: "agent is not active yet" }, 409);
    pilotClient ??= circle();
    const result = await executeWithdrawal(pilotClient, entry, amount);
    return json(
      res,
      { outcome: result.outcome, detail: result.detail, txHash: result.txHash ?? null, runId: result.runId },
      result.outcome === "acted" ? 200 : 400,
    );
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
    const tickers = store.marketSymbols();
    const named_ = (rows as Array<Record<string, unknown>>).map((r) => ({
      ...r,
      reason: r.reason === null || r.reason === undefined ? r.reason : named(String(r.reason), tickers),
      symbol: r.market_id ? (tickers.get(String(r.market_id)) ?? null) : null,
    }));
    return json(res, { runs: named_ });
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
        creatorHandle: m.creatorHandle,
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
      /**
       * What happened lately, newest first — from the platform's own record
       * rather than from the flow window above.
       *
       * The window is 10,000 blocks because that is what one eth_getLogs may
       * ask for, which is about eighty-five minutes of a half-second chain. It
       * is the right horizon for a trading decision and the wrong one for a
       * page: a reader who arrives during a quiet spell was being told the
       * economy had nothing in it, when what was true is that nothing had
       * happened in the last hour and a half. The ledger keeps every trade, so
       * the feed shows the last of them and says how long ago each was.
       */
      recentTrades: feed
        .recent(60)
        .filter((e) => e.type === "buy" || e.type === "sell")
        .slice(0, 20)
        .map((e) => ({
          marketId: e.marketId,
          symbol: e.symbol || (store.marketSymbol(e.marketId) ?? ""),
          trader: e.actor.wallet,
          traderHandle: e.actor.handle,
          side: e.type as "buy" | "sell",
          usdc: e.usdc,
          at: e.at,
          txHash: e.txHash,
          logIndex: 0,
          blockNumber: e.blockNumber,
        })),
    });
  }

  /**
   * The platform's own record of what happened, newest first.
   *
   * Public on purpose: everything in it is already on the chain, and an agent
   * that must reason about other agents should read the same record a person
   * does rather than a private one.
   */
  if (url.pathname === "/events") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 40), 200);
    return json(res, {
      events: feed.recent(limit).map(eventJson),
      status: feed.ingestStatus(),
    });
  }

  // One agent as the rest of the platform sees it: who it is, what it launched,
  // what it has been doing. A handle nobody holds is a 404, not an empty page —
  // "did you mean" belongs to the caller, and guessing belongs to nobody.
  const agentPath = /^\/agents\/([^/]+)(\/activity|\/launches)?$/.exec(url.pathname);
  if (req.method === "GET" && agentPath) {
    const handle = decodeURIComponent(agentPath[1]).replace(/^@/, "").toLowerCase();
    const actor = actorByHandle(handle);
    if (!actor) {
      return json(res, { error: `no agent called @${handle}`, nearest: nearestHandles(handle) }, 404);
    }
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 40), 200);
    const sinceMs = Number(url.searchParams.get("sinceMs") ?? 0);

    if (agentPath[2] === "/activity") {
      return json(res, { handle, activity: feed.activityOf(handle, limit, sinceMs).map(eventJson) });
    }
    if (agentPath[2] === "/launches") {
      return json(res, { handle, launches: feed.launchesOf(handle, limit).map(eventJson) });
    }

    const entry = resolve(handle);
    return json(res, {
      handle,
      agentId: actor.agentId,
      wallet: actor.wallet,
      kind: actor.kind,
      approach: entry?.approach ?? null,
      state: entry ? publicState({ state: entry.state, name: entry.name }) : null,
      marketsLaunched: feed.launchesOf(handle, 50).map(eventJson),
      positions: store.positionsOf(handle).filter((p) => p.tokens > 0n).map((p) => ({
        marketId: p.marketId.toString(),
        symbol: store.marketSymbol(p.marketId),
        tokens: p.tokens.toString(),
        costUsdc: p.costUsdc.toString(),
      })),
      recentActivity: feed.activityOf(handle, limit).map(eventJson),
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

  // A conversation between an operator and their agent is private, and the
  // roster publishes every agent's owner — so knowing an address must not be
  // enough to read one. Proof of the wallet is.
  if (req.method === "GET" && url.pathname === "/chat/history") {
    const proven = await provenAgent(req, url.searchParams.get("handle") ?? "");
    if ("error" in proven) return json(res, { error: proven.error }, proven.status);
    const row = proven.row;
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

  /**
   * Confirm a proposal.
   *
   * A proposal that stays inside the operator's own rules is theirs already —
   * the grant that let them ask for it is the same authority that lets it
   * happen, so it costs one click and no wallet. A proposal that crosses one of
   * those rules is the exception the wallet exists for: the signature covers
   * the confirmation id and a hash of the exact proposal, so what executes is
   * what was shown, and the override is recorded against a fresh signature
   * rather than a day-old session.
   */
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
    const crossesARule = requiresWalletSignature(active);
    if (crossesARule && body.expiry !== undefined) {
      // A grant is a session, and an override is not a session-level act.
      return json(
        res,
        {
          error:
            active.type === "withdraw"
              ? "moving money out always takes a signature"
              : "this crosses a rule you set — confirm it with a signature",
        },
        403,
      );
    }
    const err = crossesARule
      ? await verifyOwnerAction(body, `confirm #${id} ${hash}`, row.name, row.owner ?? "")
      : await operatorAuth(body, row, `confirm #${id} ${hash}`);
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
      } else if (consumed.type === "withdraw") {
        const entry = resolve(row.name);
        if (!entry) throw new Error("agent is not active");
        const payload = JSON.parse(consumed.payload) as { amountUsdc: string };
        pilotClient ??= circle();
        const r = await executeWithdrawal(pilotClient, entry, BigInt(payload.amountUsdc.replace(/n$/, "")));
        txHash = r.txHash ?? null;
        result =
          r.outcome === "acted"
            ? `done — ${r.detail}`
            : r.outcome === "rejected"
              ? `refused — ${r.detail}`
              : `failed — ${r.detail}`;
      } else {
        result = applyChange(
          row,
          consumed.type,
          JSON.parse(consumed.payload, (_k, v) =>
            typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
          ) as Record<string, unknown>,
        );
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

  /**
   * The tab saying it is still here, and asking whether anything happened.
   *
   * This is the whole of the awake model for a visitor agent: while its
   * operator's tab polls, the agent can be reached by an event; when the tab
   * closes, events pass it by and are recorded as missed rather than queued.
   * The call is a pair of indexed reads, cheap enough to make every few
   * seconds, which is what keeps a reaction close to the thing it answers.
   */
  if (req.method === "POST" && url.pathname === "/pilot/pending") {
    const body = await readJson(req);
    const owner = String(body.owner ?? "").toLowerCase();
    const mine = owner ? store.userAgentsListByOwner(owner) : [];
    if (mine.length === 0) return json(res, { agents: [] });
    const authErr = await verifyPilotGrant(body, owner);
    if (authErr) return json(res, { error: authErr }, 403);

    const flying = mine.filter((r) => r.state === "active" && !store.isPaused(r.name));
    for (const r of flying) store.markSeen(r.name);
    return json(res, {
      agents: store.agentsWithPendingFires(flying.map((r) => r.name)),
      awake: flying.map((r) => r.name),
    });
  }

  // An agent's triggers, and what they have actually done.
  // Who an agent follows is private for a reason beyond privacy: a follower's
  // reaction is predictable, so publishing the relationship would let the
  // followed agent trade against it.
  if (req.method === "GET" && url.pathname === "/triggers") {
    const proven = await provenAgent(req, url.searchParams.get("handle") ?? "");
    if ("error" in proven) return json(res, { error: proven.error }, proven.status);
    const row = proven.row;
    return json(res, {
      triggers: store.triggersOf(row.name).map((t) => triggerJson(t)),
      recentFires: store.firesOf(row.name, 20).map(fireJson),
    });
  }

  if (req.method === "POST" && url.pathname.startsWith("/triggers/")) {
    const body = await readJson(req);
    const row = ownedAgent(String(body.owner ?? ""), String(body.handle ?? ""));
    if (!row) return json(res, { error: "this wallet controls no such agent" }, 404);
    const op = url.pathname.slice("/triggers/".length);

    if (op === "add") {
      const plan = planTrigger(row.name, {
        targetHandle: String(body.targetHandle ?? ""),
        event: String(body.event ?? "market_launched") as store.TriggerEvent,
        mode: String(body.mode ?? "watch") as store.TriggerMode,
        sizing: (body.sizing ?? null) as store.TriggerSizing,
        amountUsdc: body.amountUsdc === undefined || body.amountUsdc === null ? null : BigInt(String(body.amountUsdc)),
        proportionBps: body.proportionBps === undefined ? null : Number(body.proportionBps),
        overrideRisk: body.overrideRisk === true,
      });
      if ("error" in plan) return json(res, { error: plan.error }, 400);

      // A trigger that may cross the agent's own limits is a standing
      // authority over money, granted now for actions nobody has seen yet.
      // That is the one thing the wallet still signs.
      const err = plan.request.overrideRisk
        ? await verifyOwnerAction(
            body,
            `trigger override ${confirmationHash(JSON.stringify(plan.request, bigintSafe), plan.summary)}`,
            row.name,
            row.owner ?? "",
          )
        : await operatorAuth(body, row, "trigger add");
      if (err) return json(res, { error: err }, 403);

      try {
        const id = createTrigger(row.name, plan.request);
        return json(res, { id, summary: plan.summary });
      } catch (e) {
        return json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }

    if (op === "toggle" || op === "delete") {
      const err = await operatorAuth(body, row, `trigger ${op} #${Number(body.id ?? 0)}`);
      if (err) return json(res, { error: err }, 403);
      const id = Number(body.id ?? 0);
      const ok =
        op === "toggle"
          ? store.triggerSetEnabled(row.name, id, body.enabled === true)
          : store.triggerDelete(row.name, id);
      return json(res, ok ? { ok: true } : { error: "no such trigger" }, ok ? 200 : 404);
    }

    return json(res, { error: "not found" }, 404);
  }

  // An operator's rules are how they told their agent to behave — their
  // working strategy, not a published one.
  if (req.method === "GET" && url.pathname === "/rules") {
    const proven = await provenAgent(req, url.searchParams.get("handle") ?? "");
    if ("error" in proven) return json(res, { error: proven.error }, proven.status);
    const row = proven.row;
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

  // Panel mutations: no LLM in the path, and no signature either — a rule is
  // the operator writing down their own constraint, and charging a wallet popup
  // for that taught them to keep the list short instead of keeping it true.
  // The fallback message is still accepted so a tab without a grant can sign.
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
    const err = await operatorAuth(body, row, actionMsg);
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
    const err = await operatorAuth(body, row, actionMsg);
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
