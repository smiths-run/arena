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
import { treasuryGrant } from "./agent-factory.ts";
import * as executor from "./executor.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";

const client = circle();
const once = process.argv.includes("--once");

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

/**
 * The funding sweep: one ungranted visitor agent per attempt, at most one
 * attempt a minute. An agent that already holds money (funded at creation,
 * or out-of-band) is marked granted without a transfer, so the sweep can
 * never double-fund; an agent the treasury cannot reach yet stays on the
 * list and its runs keep saying, publicly, that it is broke.
 */
async function fundOneVisitor(): Promise<void> {
  if (!process.env.TREASURY_WALLET_ID) return;
  const next = store.userAgentsUngranted()[0];
  if (!next) return;
  const last = Number(store.settingGet("grant_last_attempt") ?? 0);
  if (Date.now() - last < 60_000) return;
  store.settingSet("grant_last_attempt", String(Date.now()));
  try {
    const balance = await obs.walletUsdc(next.address as `0x${string}`);
    if (balance >= 2_000_000n) {
      store.userAgentMarkGranted(next.name);
      return;
    }
    if (await treasuryGrant(client, next.address, BigInt(next.grant_usdc ?? "3000000"))) {
      store.userAgentMarkGranted(next.name);
      console.log(`treasury funded ${next.name}`);
    }
  } catch (err) {
    console.log(`treasury grant for ${next.name} failed — ${err instanceof Error ? err.message : err}`);
  }
}

async function pass(): Promise<void> {
  // The heartbeat is how Mission Control knows this loop is alive; stamped per
  // pass, not per run, so a quiet pass still counts as presence.
  store.heartbeat();
  await fundOneVisitor();
  const held = heldAgents();
  // Re-read the roster every pass: a visitor agent created a second ago is
  // part of the economy on the next tick, no restart required.
  for (const agent of fullRoster()) {
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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pass();
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
