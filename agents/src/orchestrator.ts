/**
 * The scheduler. Reconciles first, then wakes each agent on its cooldown —
 * serialized per agent, so one wallet never has two runs in flight.
 *
 *   npm run once           # a single pass over every agent, then exit
 *   npm run orchestrate    # continuous
 */
import { AGENTS, circle } from "./shared.ts";
import { STRATEGIES } from "./config.ts";
import { runOnce } from "./runtime.ts";
import * as executor from "./executor.ts";
import * as store from "./store.ts";

const client = circle();
const once = process.argv.includes("--once");

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

async function pass(): Promise<void> {
  const held = heldAgents();
  for (const agent of AGENTS) {
    if (held.has(agent.name)) continue;
    const cooldownMs = STRATEGIES[agent.name].cooldownSeconds * 1000;
    const since = Date.now() - store.lastRunAt(agent.name);
    if (!once && since < cooldownMs) continue;
    await runOnce(agent.name, once ? "manual" : "schedule", client);
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
  console.log(`orchestrating ${AGENTS.length} agents; ctrl-c to stop`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pass();
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
