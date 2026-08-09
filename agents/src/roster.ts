/**
 * One place that answers "which agents exist, and under what strategy?"
 *
 * The three house agents come from config and env; Smiths agents come from
 * the ledger. Everything downstream — the orchestrator's pass, a run's agent
 * lookup, the public API — resolves through here. The primary human-readable
 * key is the handle.
 */
import { AGENTS } from "./shared.ts";
import { STRATEGIES, type Strategy } from "./config.ts";
import {
  DEFAULT_MANDATE,
  deserializeStrategy,
  type Approach,
} from "./visitor-strategy.ts";
import * as store from "./store.ts";

export type AgentState = "awaiting_funding" | "activating" | "active" | "paused" | "error_recoverable";

export interface RosterEntry {
  /** The agent's handle — canonical human-readable identity. */
  name: string;
  walletId: string;
  address: `0x${string}`;
  owner: `0x${string}` | null;
  agentId: bigint | null;
  approach: Approach;
  mandate: string | null;
  description: string;
  strategy: Strategy;
  kind: "house" | "visitor";
  state: AgentState;
}

const HOUSE_APPROACH: Record<string, Approach> = {
  anvil: "momentum",
  bellows: "contrarian",
  tongs: "builder",
};

// The house agents' identities were minted in M3 and recorded; static is fine.
const HOUSE_AGENT_IDS: Record<string, bigint> = {
  anvil: 859_270n,
  bellows: 859_271n,
  tongs: 859_272n,
};

export function fullRoster(): RosterEntry[] {
  const house: RosterEntry[] = AGENTS.map((a) => ({
    name: a.name,
    walletId: a.walletId,
    address: a.address,
    owner: null,
    agentId: HOUSE_AGENT_IDS[a.name] ?? null,
    approach: HOUSE_APPROACH[a.name] ?? "momentum",
    mandate: null,
    description: a.description,
    strategy: STRATEGIES[a.name],
    kind: "house",
    state: "active",
  }));
  const visitors: RosterEntry[] = store.userAgents().map((r) => {
    const strategy = deserializeStrategy(r.strategy);
    // Every Smiths agent thinks by default — enforced here so agents created
    // under the older mission-gated rule are upgraded on read, not migrated.
    strategy.llm = { enabled: true, maxCallsPerDay: strategy.llm.maxCallsPerDay || 30 };
    return {
      name: r.name,
      walletId: r.wallet_id,
      address: r.address as `0x${string}`,
      owner: (r.owner as `0x${string}` | null) ?? null,
      agentId: r.agent_id ? BigInt(r.agent_id) : null,
      approach: (r.approach as Approach) ?? "scout",
      mandate: r.mission,
      description: r.mission ?? DEFAULT_MANDATE,
      strategy,
      kind: "visitor" as const,
      state: (r.state as AgentState) ?? "active",
    };
  });
  return [...house, ...visitors];
}

export function resolve(name: string): RosterEntry | null {
  return fullRoster().find((e) => e.name === name) ?? null;
}
