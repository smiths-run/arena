/**
 * The scheduler. Reconciles first, then wakes each agent on its cooldown —
 * serialized per agent, so one wallet never has two runs in flight.
 *
 *   npm run once           # a single pass over every agent, then exit
 *   npm run orchestrate    # continuous
 */
import { circle } from "./shared.ts";
import { fullRoster, type RosterEntry } from "./roster.ts";
import { runOnce } from "./runtime.ts";
import { decide } from "./schedule.ts";
import { heuristicStrategist, type Strategist } from "./strategist.ts";
import { llmStrategist } from "./llm-strategist.ts";
import { ensureHandle, ensureIdentity } from "./identity.ts";
import { advanceHistory } from "./history.ts";
import { ingest } from "./events.ts";
import * as executor from "./executor.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

const client = circle();
const once = process.argv.includes("--once");

/**
 * How often the world is read while it is being watched rather than caught up.
 *
 * A topic-filtered read at the head costs about a tenth of a second, so two
 * seconds is a cheap heartbeat: it puts a launch in front of the agents that
 * follow it about a second and a half after the block carrying it settles.
 * While backfilling the same loop slows down — history has waited this long
 * and can wait a few seconds more, whereas an agent run cannot.
 */
const WATCH_INTERVAL_MS = 2_000;
const CATCHUP_INTERVAL_MS = 5_000;

/**
 * The event walk, running independently of the agent passes.
 *
 * It is deliberately not part of pass(): an agent run can take seconds, and
 * the whole point of watching is that a follower hears about a launch without
 * waiting for whatever else the scheduler happens to be doing.
 */
async function watchTheWorld(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let live = false;
    try {
      const r = await ingest();
      live = r.live;
      if (r.appended > 0) console.log(`world: +${r.appended} event(s) at block ${r.at}`);
    } catch (err) {
      console.error(`world watch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, live ? WATCH_INTERVAL_MS : CATCHUP_INTERVAL_MS));
  }
}

/**
 * The LLM proposes only where the strategy enables it and a key exists; the
 * cap and every failure path inside llmStrategist fall back to the heuristic,
 * so this choice affects who proposes — never whether the loop runs.
 */
function strategistFor(entry: RosterEntry): Strategist {
  return entry.strategy.llm.enabled && process.env.ANTHROPIC_API_KEY
    ? llmStrategist
    : heuristicStrategist;
}

const { closed, replayed } = await executor.reconcile(client);
if (closed > 0) console.log(`reconciled ${closed} pending transaction(s) from a previous life`);
if (replayed > 0) {
  console.log(`replayed local effects for ${replayed} transaction(s) that reached the chain unrecorded`);
}

/**
 * An agent with a transaction still in flight must not start another run — its
 * position and spend are unknown until that one lands. Recomputed every pass
 * rather than once at startup, so an agent is released the moment its
 * transaction settles instead of waiting for a restart.
 */
function heldAgents(): Set<string> {
  return new Set(store.unresolvedPending().map((r) => r.agent));
}

for (const name of heldAgents()) {
  console.log(`${name}: held — a Circle transaction is still in flight`);
}

/** Enough for the 1 USDC launch, the 0.5 reserve and gas — the activation bar. */
const ACTIVATION_MINIMUM = 2_000_000n;

/** Log the history walk's progress while it runs, and its arrival once. */
let historyDone = false;

/**
 * The activation sweep: one agent per pass, at most one attempt a minute.
 * A funded agent gets its ERC-8004 identity and its permanent Smiths handle
 * — both claimed from its own wallet — and only then joins the run loop,
 * with its first run scheduled immediately. Each step is idempotent, so a
 * crash mid-activation resumes instead of duplicating; a handle lost to a
 * race parks the agent in error_recoverable rather than launching nameless.
 */
async function activateOneVisitor(): Promise<void> {
  const next = store.userAgentsNeedingActivation()[0];
  if (!next) return;
  const last = Number(store.settingGet("activation_last_attempt") ?? 0);
  if (Date.now() - last < 60_000) return;
  store.settingSet("activation_last_attempt", String(Date.now()));

  try {
    const balance = await obs.walletUsdc(next.address as `0x${string}`);
    if (balance < ACTIVATION_MINIMUM) {
      if (next.state !== "awaiting_funding") store.userAgentSetState(next.name, "awaiting_funding");
      return;
    }
    if (next.state !== "activating") store.userAgentSetState(next.name, "activating");

    const agent = {
      name: next.name,
      walletId: next.wallet_id,
      address: next.address as `0x${string}`,
      description: next.mission ?? "Autonomous Smiths Run market agent on Arc.",
    };

    const { agentId, txHash } = await ensureIdentity(client, agent, { agentId: next.agent_id });
    store.userAgentSetIdentity(next.name, agentId.toString(), txHash);

    const claim = await ensureHandle(client, agent, agentId, next.name);
    store.userAgentSetHandleTx(next.name, claim.txHash);

    store.userAgentSetState(next.name, "active");
    // No first run here: visitor agents fly only under an operator's open tab.
    // The pilot's first tick lands immediately — a fresh agent has no cooldown.
    console.log(`activated @${next.name} — identity ${agentId}, handle claimed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`activation of @${next.name} failed — ${msg}`);
    if (msg.includes("is taken") || msg.includes("already holds handle")) {
      store.userAgentSetState(next.name, "error_recoverable");
    }
  }
}

async function pass(): Promise<void> {
  // The heartbeat is how Mission Control knows this loop is alive; stamped per
  // pass, not per run, so a quiet pass still counts as presence.
  store.heartbeat();

  // Walk a few ranges of market history per pass. It shares the agents' rate
  // limit budget, which is why it takes four ranges and not a hundred: the
  // whole history lands within minutes and then only tails the head.
  try {
    const { at, head, caughtUp } = await advanceHistory();
    if (caughtUp) {
      if (!historyDone) {
        console.log("market history caught up with the chain");
        historyDone = true;
      }
    } else {
      historyDone = false;
      const done = Number(at - 55_002_424n);
      const total = Number(head - 55_002_424n);
      console.log(`market history ${((done / total) * 100).toFixed(1)}% — block ${at}`);
    }
  } catch (err) {
    console.log(`history walk paused — ${err instanceof Error ? err.message : String(err)}`);
  }

  await activateOneVisitor();
  const held = heldAgents();
  // Re-read the roster every pass: an agent activated a second ago is part
  // of the economy on the next tick, no restart required. Only ACTIVE agents
  // run — an agent without its identity and handle does not act.
  //
  // Visitor agents are not scheduled here at all: the platform does not host
  // them. They run only while their operator's browser tab is open, one tick
  // at a time through POST /agent/tick. The house three are ours to host.
  for (const agent of fullRoster()) {
    if (agent.kind === "visitor") continue;
    if (agent.state !== "active") continue;
    const isHeld = held.has(agent.name);
    const verdict = decide({
      held: isHeld,
      // Consuming the request only when not held keeps an operator's click
      // pending through the hold instead of silently discarding it.
      requested: isHeld ? false : store.takeRunRequest(agent.name),
      paused: store.isPaused(agent.name),
      once,
      sinceLastRunMs: Date.now() - store.lastRunAt(agent.name),
      cooldownMs: agent.strategy.cooldownSeconds * 1000,
    });
    if (!verdict.run) continue;
    await runOnce(agent.name, verdict.trigger, client, strategistFor(agent));
  }
}

if (once) {
  await pass();
  console.log("\nrecent runs:");
  for (const r of store.recentRuns(6) as any[]) {
    // Reasons can be multiline error dumps; the run table keeps them whole, the
    // console summary shows one line.
    const reason = (r.reason ?? "").split("\n")[0].slice(0, 100);
    console.log(
      `  #${r.id} ${r.agent} ${r.outcome}${r.action_kind ? ` (${r.action_kind})` : ""} — ${reason}`,
    );
  }
} else {
  console.log(`orchestrating ${fullRoster().length} agents; ctrl-c to stop`);
  void watchTheWorld();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // A pass that throws is a bad minute, not a dead economy. Without this the
    // rejection ends the process, and because the three agent processes share
    // a container, every one of them restarts with it.
    try {
      await pass();
    } catch (err) {
      console.error(`pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
