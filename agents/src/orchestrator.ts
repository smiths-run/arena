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

const pending = await executor.reconcile(client);
if (pending > 0) console.log(`reconciled ${pending} pending transaction(s) from a previous life`);

const stillOpen = store.unresolvedPending();
const heldAgents = new Set(stillOpen.map((r) => r.agent));
for (const name of heldAgents) {
  console.log(`${name}: held — a Circle transaction is still in flight from before restart`);
}

async function pass(): Promise<void> {
  for (const agent of AGENTS) {
    if (heldAgents.has(agent.name)) continue;
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
