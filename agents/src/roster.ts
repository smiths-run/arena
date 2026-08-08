/**
 * One place that answers "which agents exist, and under what strategy?"
 *
 * The three house agents come from config and env; visitor agents come from
 * the ledger. Everything downstream — the orchestrator's pass, a run's agent
 * lookup, the receipts listing — resolves through here, so a visitor agent is
 * a first-class citizen of the same loop the moment its row exists.
 */
import { AGENTS } from "./shared.ts";
import { STRATEGIES, type Strategy } from "./config.ts";
import { deserializeStrategy } from "./visitor-strategy.ts";
import * as store from "./store.ts";

export interface RosterEntry {
  name: string;
  walletId: string;
  address: `0x${string}`;
  description: string;
  strategy: Strategy;
  kind: "house" | "visitor";
}

export function fullRoster(): RosterEntry[] {
  const house: RosterEntry[] = AGENTS.map((a) => ({
    name: a.name,
    walletId: a.walletId,
    address: a.address,
    description: a.description,
    strategy: STRATEGIES[a.name],
    kind: "house",
  }));
  const visitors: RosterEntry[] = store.userAgents().map((r) => ({
    name: r.name,
    walletId: r.wallet_id,
    address: r.address as `0x${string}`,
    // The visitor's mission is the agent's brief; the LLM strategist reads it
    // verbatim. Without one, a plain description does.
    description:
      r.mission ??
      "Visitor-created agent on Smiths Run. Trades bonding-curve markets on Arc Testnet within a bounded USDC budget; every action and its cost are public.",
    strategy: deserializeStrategy(r.strategy),
    kind: "visitor",
  }));
  return [...house, ...visitors];
}

export function resolve(name: string): RosterEntry | null {
  return fullRoster().find((e) => e.name === name) ?? null;
}
