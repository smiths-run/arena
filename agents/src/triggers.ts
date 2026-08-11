/**
 * One agent reacting to another, the moment it happens.
 *
 * A rule like "buy every coin @mfmf launches" has two halves. The first is
 * observation, and it lives in events.ts: the platform's own record of who did
 * what. The second is here — turning that record into an action while it still
 * means something, without waiting for a scheduled run that may be minutes
 * away.
 *
 * Four things keep this from being dangerous.
 *
 * Exactly once: a trigger and an event are unique together, so a restart that
 * re-reads the chain cannot buy the same launch twice.
 *
 * No loops: two agents told to mirror each other would answer each other's
 * trades until both wallets were gone, paying the curve on every lap. A
 * trigger never fires on an event one of our own triggers produced, and a
 * mutual pair is refused at creation rather than discovered in the ledger.
 *
 * Bounded: every trigger carries a per-action cap and a daily budget of its
 * own. A standing instruction the operator confirmed once must not be able to
 * spend without limit later, and the agent's normal policy still applies
 * unless the operator explicitly scoped the trigger to cross it. The contract's
 * hard guardrails are above all of it and cross nothing.
 *
 * Awake only: an agent reacts while it is running — a house agent always, a
 * visitor's while its operator's tab is flying it. When the follower is not
 * awake the event is recorded as missed rather than queued, because a launch
 * answered an hour late is not the instruction anybody gave.
 */
import { circle } from "./shared.ts";
import { resolve, type RosterEntry } from "./roster.ts";
import { actorByHandle, actorOf, nearestHandles } from "./actors.ts";
import { executeDirected, observeFor } from "./operator.ts";
import { decideLayered, type Action } from "./policy.ts";
import { runOnce } from "./runtime.ts";
import { heuristicStrategist, type Strategist } from "./strategist.ts";
import * as feed from "./events.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

/**
 * How recently an agent must have been seen to count as awake.
 *
 * The scheduler stamps its agents once a pass and an operator's tab stamps
 * theirs while it polls, both well inside this. It is deliberately short: the
 * whole promise is that a follower acts while it is running, so a stale stamp
 * should read as "not there" quickly.
 */
export const AWAKE_WINDOW_MS = 45_000;

/**
 * How long a fire may wait for its agent before it is retired unexecuted.
 *
 * Long enough to survive a slow tick, short enough that nothing executes
 * against a market that has moved on. There is no queue behind this: a fire
 * that expires is a fact in the record, not work waiting to happen.
 */
export const FIRE_TTL_MS = 90_000;

/** Defaults for a trigger nobody bounded explicitly. */
export const DEFAULT_MAX_ACTION_USDC = 1_000_000n;
export const DEFAULT_DAILY_BUDGET_USDC = 3_000_000n;
/** A standing authority with no end is a standing risk; 30 days by default. */
export const DEFAULT_LIFETIME_MS = 30 * 24 * 3600 * 1000;

const usd = (v: bigint) => (Number(v) / 1e6).toString();

export interface TriggerRequest {
  targetHandle: string;
  event: store.TriggerEvent;
  mode: store.TriggerMode;
  sizing?: store.TriggerSizing;
  amountUsdc?: bigint | null;
  proportionBps?: number | null;
  dailyBudgetUsdc?: bigint;
  maxActionUsdc?: bigint;
  overrideRisk?: boolean;
  lifetimeMs?: number;
}

export interface TriggerPlan {
  request: Required<Omit<TriggerRequest, "lifetimeMs">> & { expiresAt: number };
  /** What the operator is agreeing to, in one sentence. */
  summary: string;
}

/**
 * Turn a request into something that can be stored, or say why it cannot be.
 *
 * Refusing here is the point: a trigger that names an agent nobody can find,
 * or that closes a mirror loop, is not a rule the runtime can honour, and a
 * rule the runtime cannot honour should never be written down.
 */
export function planTrigger(agent: string, req: TriggerRequest): TriggerPlan | { error: string } {
  const wanted = (req.targetHandle ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!wanted) return { error: "which agent should be followed?" };

  const target = actorByHandle(wanted);
  if (!target?.handle) {
    const near = nearestHandles(wanted);
    return {
      error: near.length
        ? `there is no @${wanted} on Smiths — did you mean ${near.map((h) => `@${h}`).join(" or ")}?`
        : `there is no @${wanted} on Smiths`,
    };
  }
  if (target.handle === agent) return { error: "an agent cannot follow itself" };

  // A mutual mirror is a money-burning loop, so it is refused where it is
  // written rather than discovered later in the ledger.
  const theirs = store.triggersOf(target.handle);
  const mutual = theirs.find(
    (t) => t.enabled && t.targetHandle === agent && (t.mode === "mirror" || t.mode === "evaluate"),
  );
  if (mutual && (req.mode === "mirror" || req.mode === "evaluate")) {
    return {
      error: `@${target.handle} already reacts to you, and two agents reacting to each other would trade in a loop until both wallets were empty`,
    };
  }

  const mode = req.mode;
  const event = req.event;
  if (!["watch", "evaluate", "mirror"].includes(mode)) return { error: `unknown mode ${mode}` };
  if (!["market_launched", "buy", "sell", "any"].includes(event)) {
    return { error: `unknown event ${event}` };
  }

  let sizing: store.TriggerSizing = req.sizing ?? null;
  let amountUsdc = req.amountUsdc ?? null;
  let proportionBps = req.proportionBps ?? null;

  if (mode === "watch") {
    sizing = null;
    amountUsdc = null;
    proportionBps = null;
  } else {
    // Anything that can trade must say how much. "The same amount" is a real
    // answer; silence is not, and a follower guessing its own size is how a
    // 0.5 USDC instruction becomes a 4 USDC one.
    sizing = sizing ?? "fixed";
    if (sizing === "fixed") {
      if (amountUsdc === null || amountUsdc <= 0n) return { error: "a fixed size needs an amount in USDC" };
      proportionBps = null;
    } else if (sizing === "proportional") {
      if (!proportionBps || proportionBps <= 0) return { error: "a proportional size needs a percentage" };
      amountUsdc = null;
    } else if (sizing === "same_amount") {
      amountUsdc = null;
      proportionBps = null;
    } else {
      return { error: `unknown sizing ${sizing}` };
    }
  }

  const maxActionUsdc = req.maxActionUsdc ?? bigger(amountUsdc, DEFAULT_MAX_ACTION_USDC);
  const dailyBudgetUsdc = req.dailyBudgetUsdc ?? bigger(maxActionUsdc * 3n, DEFAULT_DAILY_BUDGET_USDC);
  const expiresAt = Date.now() + (req.lifetimeMs ?? DEFAULT_LIFETIME_MS);

  return {
    request: {
      targetHandle: target.handle,
      event,
      mode,
      sizing,
      amountUsdc,
      proportionBps,
      dailyBudgetUsdc,
      maxActionUsdc,
      overrideRisk: req.overrideRisk === true,
      expiresAt,
    },
    summary: describePlan({
      targetHandle: target.handle,
      event,
      mode,
      sizing,
      amountUsdc,
      proportionBps,
      dailyBudgetUsdc,
      maxActionUsdc,
      overrideRisk: req.overrideRisk === true,
      expiresAt,
    }),
  };
}

function bigger(a: bigint | null, b: bigint): bigint {
  return a !== null && a > b ? a : b;
}

type PlanShape = TriggerPlan["request"];

/** The exact promise a trigger makes, in words the operator can check. */
export function describePlan(p: PlanShape): string {
  const when =
    p.event === "market_launched"
      ? `launches a market`
      : p.event === "buy"
        ? `buys`
        : p.event === "sell"
          ? `sells`
          : `acts`;

  if (p.mode === "watch") {
    return `Watch @${p.targetHandle}: record what they do and let me use it, but trade nothing automatically.`;
  }

  const size =
    p.sizing === "fixed"
      ? `${usd(p.amountUsdc ?? 0n)} USDC`
      : p.sizing === "same_amount"
        ? `the same USDC amount they used`
        : `${(p.proportionBps ?? 0) / 100}% of their size`;

  const act = p.mode === "mirror" ? `do the same with ${size}` : `evaluate it and act only if it fits, up to ${size}`;

  return (
    `When @${p.targetHandle} ${when}, ${act} — immediately, without waiting for my normal cycle. ` +
    `At most ${usd(p.maxActionUsdc)} USDC per action and ${usd(p.dailyBudgetUsdc)} USDC a day through this rule. ` +
    (p.overrideRisk
      ? `This may cross my normal risk limits. `
      : `My normal risk limits still apply. `) +
    `Protocol hard limits can never be crossed. Expires ${new Date(p.expiresAt).toISOString().slice(0, 10)}.`
  );
}

export function createTrigger(agent: string, plan: PlanShape): number {
  return store.triggerCreate({
    agent,
    targetHandle: plan.targetHandle,
    event: plan.event,
    mode: plan.mode,
    sizing: plan.sizing,
    amountUsdc: plan.amountUsdc,
    proportionBps: plan.proportionBps,
    dailyBudgetUsdc: plan.dailyBudgetUsdc,
    maxActionUsdc: plan.maxActionUsdc,
    overrideRisk: plan.overrideRisk,
    expiresAt: plan.expiresAt,
  });
}

// ── matching ───────────────────────────────────────────────────────────────

export function isAwake(agent: string): boolean {
  return Date.now() - store.lastSeenAt(agent) < AWAKE_WINDOW_MS;
}

export interface MatchResult {
  considered: number;
  fired: number;
  missed: number;
}

/**
 * Walk the events that arrived since the last look and wake whoever follows
 * them. Cheap enough to run on every watch tick: it is a cursor read over rows
 * this process just wrote.
 */
export function matchNewEvents(): MatchResult {
  const from = Number(store.settingGet("trigger_cursor_seq") ?? 0);
  const events = store.eventsSince(from, 200);
  const result: MatchResult = { considered: events.length, fired: 0, missed: 0 };
  if (events.length === 0) return result;

  for (const event of events) {
    const actor = actorOf(event.actorWallet);
    if (!actor.handle) continue; // nobody we know acted; nothing follows a stranger

    // Our own triggered trades never trigger anyone. This is the loop brake.
    if (store.txIsTriggerOrigin(event.txHash)) continue;

    for (const trigger of store.triggersWatching(actor.handle)) {
      if (trigger.agent === actor.handle) continue;
      if (trigger.event !== "any" && trigger.event !== event.type) continue;
      // A rule answers what happens after it exists. Without this, saving a
      // trigger would replay the whole backfilled history at once.
      if (event.at < trigger.createdAt) continue;

      const awake = isAwake(trigger.agent);
      const status: store.TriggerFireStatus = awake
        ? trigger.mode === "watch"
          ? "observed"
          : "pending"
        : "missed_offline";
      const detail = awake
        ? feed.describe(feed.view(event))
        : `${feed.describe(feed.view(event))} — this agent was not awake, so nothing was done`;
      const created = store.fireCreate(trigger.id, trigger.agent, event.id, status, detail);
      if (created === null) continue; // already seen: exactly once
      if (awake) result.fired++;
      else result.missed++;
    }
  }

  store.settingSet("trigger_cursor_seq", String(events[events.length - 1].seq));
  return result;
}

// ── acting ─────────────────────────────────────────────────────────────────

/**
 * Size the follower's trade against the one it is following.
 *
 * Every path is bounded twice — by the trigger's own per-action cap and by
 * what is left of its daily budget — before the agent's policy ever sees it.
 */
export function sizeFor(trigger: store.TriggerRow, sourceUsdc: bigint): bigint {
  const raw =
    trigger.sizing === "fixed"
      ? (trigger.amountUsdc ?? 0n)
      : trigger.sizing === "proportional"
        ? (sourceUsdc * BigInt(trigger.proportionBps ?? 0)) / 10_000n
        : sourceUsdc;
  const capped = raw > trigger.maxActionUsdc ? trigger.maxActionUsdc : raw;
  const spent = store.triggerSpent24h(trigger.id);
  const left = trigger.dailyBudgetUsdc > spent ? trigger.dailyBudgetUsdc - spent : 0n;
  return capped > left ? left : capped;
}

/**
 * What the follower does about one event.
 *
 * A launch or a buy by the target means buying that market; a sell means
 * selling the same share of our own position as they sold of theirs, which is
 * the only reading of "the same" that survives two different position sizes.
 */
async function actionFor(
  entry: RosterEntry,
  trigger: store.TriggerRow,
  event: store.PlatformEventRow,
): Promise<{ action: Action } | { skip: string }> {
  const marketId = BigInt(event.marketId);

  if (event.type === "sell") {
    const held = store.getPosition(entry.name, marketId)?.tokens ?? 0n;
    if (held <= 0n) return { skip: "nothing held in that market" };
    const sold = BigInt(event.tokens);
    if (sold <= 0n) return { skip: "the source sale moved no tokens" };

    // Their share of their own position, applied to ours. Their balance now
    // plus what they just sold is what they held before it.
    const markets = await obs.fetchMarkets();
    const token = markets.find((m) => m.id === marketId)?.token;
    if (!token) return { skip: "that market is not on the chain we can read" };
    const target = actorByHandle(trigger.targetHandle);
    if (!target) return { skip: "the followed agent is gone" };
    const remaining = await obs.tokenBalance(token, target.wallet as `0x${string}`);
    const before = remaining + sold;
    if (before <= 0n) return { skip: "cannot tell what share they sold" };
    const tokens = (held * sold) / before;
    if (tokens <= 0n) return { skip: "their share of the sale rounds to nothing here" };
    return { action: { kind: "sell", marketId, tokens } };
  }

  const usdcIn = sizeFor(trigger, BigInt(event.usdc));
  if (usdcIn <= 0n) return { skip: "this rule has no budget left today" };
  return { action: { kind: "buy", marketId, usdcIn } };
}

/**
 * Act on one fire. Every ending is recorded — executed, skipped, rejected or
 * failed — because "why didn't you buy @mfmf's launch?" has to have an answer
 * that is not a guess.
 */
export async function handleFire(
  fire: store.TriggerFireRow,
  client: ReturnType<typeof circle>,
  strategist: Strategist = heuristicStrategist,
): Promise<void> {
  // Exactly one caller gets past this line for any one fire.
  if (!store.fireClaim(fire.id)) return;
  try {
    await act(fire, client, strategist);
  } catch (err) {
    // A claimed fire must always reach an ending. A chain read that reverts is
    // an answer to "why didn't you buy it?" — leaving the row claimed forever
    // would turn a failed reaction into silence, and take the caller down with
    // it: this is reached from an operator's tab.
    store.fireResolve(fire.id, "failed", err instanceof Error ? err.message : String(err));
  }
}

async function act(
  fire: store.TriggerFireRow,
  client: ReturnType<typeof circle>,
  strategist: Strategist,
): Promise<void> {
  const trigger = store.trigger(fire.triggerId);
  const entry = resolve(fire.agent);
  if (!trigger || !entry) {
    store.fireResolve(fire.id, "skipped", "the rule or the agent is gone");
    return;
  }
  if (!trigger.enabled) {
    store.fireResolve(fire.id, "skipped", "the rule was turned off before this could run");
    return;
  }
  if (store.isPaused(fire.agent)) {
    store.fireResolve(fire.id, "skipped", "the agent is paused");
    return;
  }

  const event = store.eventById(fire.eventId);
  if (!event) {
    store.fireResolve(fire.id, "skipped", "the event is no longer in the record");
    return;
  }
  const source = feed.describe(feed.view(event));

  // Evaluating is a normal run that simply did not wait for the cooldown: the
  // agent looks at the world it now knows about and decides for itself.
  if (trigger.mode === "evaluate") {
    try {
      await runOnce(fire.agent, "trigger", client, strategist, `${source}, and you follow @${trigger.targetHandle}`);
      store.fireResolve(fire.id, "executed", `evaluated after ${source}`);
    } catch (err) {
      store.fireResolve(fire.id, "failed", err instanceof Error ? err.message : String(err));
    }
    return;
  }

  const planned = await actionFor(entry, trigger, event).catch((err) => ({
    skip: err instanceof Error ? err.message : String(err),
  }));
  if ("skip" in planned) {
    store.fireResolve(fire.id, "skipped", `${source} — ${planned.skip}`);
    return;
  }

  // What the operator agreed to when they confirmed the rule. Conflicts with
  // the agent's own settings are acknowledged only where the trigger was
  // explicitly scoped to cross them; hard guardrails are acknowledged nowhere.
  const observation = await observeFor(entry, planned.action);
  const decision = decideLayered(planned.action, entry.strategy, observation);
  const conflicts = decision.status === "needs_override" ? decision.conflicts : [];
  if (conflicts.length > 0 && !trigger.overrideRisk) {
    store.fireResolve(
      fire.id,
      "rejected",
      `${source} — ${conflicts.map((c) => c.detail).join("; ")}. This rule was not allowed to cross your limits.`,
    );
    return;
  }

  const note = ` [trigger #${trigger.id}: ${source}${trigger.overrideRisk && conflicts.length ? ", operator-scoped override" : ""}]`;
  const result = await executeDirected(client, entry, planned.action, {
    acknowledged: conflicts,
    note,
    trigger: "trigger",
  });

  const moved = planned.action.kind === "buy" ? planned.action.usdcIn : 0n;
  store.fireResolve(
    fire.id,
    result.outcome === "acted" ? "executed" : result.outcome === "rejected" ? "rejected" : "failed",
    `${source} — ${result.detail}`,
    { runId: result.runId, usdc: result.outcome === "acted" ? moved : null },
  );
}

/**
 * Drain whatever this agent owes, newest instruction first served in order.
 * Held under a lease so the scheduler, an operator's tab and this cannot run
 * the same wallet at the same time.
 */
export async function runPendingFires(
  agent: string,
  client: ReturnType<typeof circle>,
  strategist: Strategist = heuristicStrategist,
  holder = "triggers",
): Promise<number> {
  const pending = store.firesPending(agent);
  if (pending.length === 0) return 0;
  if (!store.leaseAcquire(agent, holder, 120_000)) return 0;
  let handled = 0;
  try {
    for (const fire of pending) {
      await handleFire(fire, client, strategist);
      handled++;
    }
  } finally {
    store.leaseRelease(agent, holder);
  }
  return handled;
}
