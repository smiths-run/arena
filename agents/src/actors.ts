/**
 * Who a wallet is.
 *
 * Every economic event on Arc names a wallet, and an agent reading its world
 * has to be able to say whether that wallet is @mfmf, one of the house agents,
 * or nobody it knows. Without this the agent is reduced to guessing from
 * symbols — "MFORGE is probably @mfmf's" — which is the one thing attribution
 * must never be.
 *
 * Resolution is local and exact: house agents come from config, Smiths agents
 * from the ledger, and everything else is honestly reported as an external
 * wallet rather than being forced into a name.
 */
import { fullRoster } from "./roster.ts";

export type ActorKind = "house" | "visitor" | "external";

export interface Actor {
  wallet: string;
  /** The agent's handle, or null when the wallet belongs to nobody we know. */
  handle: string | null;
  /** ERC-8004 id once the identity sweep has registered it; null until then. */
  agentId: string | null;
  kind: ActorKind;
}

interface Index {
  byWallet: Map<string, Actor>;
  byHandle: Map<string, Actor>;
  at: number;
}

/**
 * The roster is read per resolution and an event burst resolves many wallets
 * at once, so the index is held briefly. A few seconds is short enough that a
 * newly created agent is nameable almost immediately and long enough that
 * labelling a page of trades costs one read rather than fifty.
 */
const INDEX_TTL_MS = 5_000;
let index: Index | null = null;

function build(): Index {
  const byWallet = new Map<string, Actor>();
  const byHandle = new Map<string, Actor>();
  for (const entry of fullRoster()) {
    const actor: Actor = {
      wallet: entry.address.toLowerCase(),
      handle: entry.name,
      agentId: entry.agentId !== null ? entry.agentId.toString() : null,
      kind: entry.kind,
    };
    byWallet.set(actor.wallet, actor);
    byHandle.set(entry.name.toLowerCase(), actor);
  }
  return { byWallet, byHandle, at: Date.now() };
}

function current(): Index {
  if (!index || Date.now() - index.at >= INDEX_TTL_MS) index = build();
  return index;
}

/** Forget the cached roster — for tests, and after creating an agent. */
export function forgetActors(): void {
  index = null;
}

export function actorOf(wallet: string | null | undefined): Actor {
  const key = (wallet ?? "").toLowerCase();
  return (
    current().byWallet.get(key) ?? { wallet: key, handle: null, agentId: null, kind: "external" }
  );
}

/** The agent behind a handle, or null. Accepts "@mfmf" and "MFMF" alike. */
export function actorByHandle(handle: string | null | undefined): Actor | null {
  const key = (handle ?? "").trim().replace(/^@/, "").toLowerCase();
  return key ? (current().byHandle.get(key) ?? null) : null;
}

/** Every handle on the platform, for resolution and "did you mean" answers. */
export function knownHandles(): string[] {
  return [...current().byHandle.keys()].sort();
}

/**
 * The closest handles to one that does not exist.
 *
 * A rule that names an agent nobody can find must not be saved, and the useful
 * refusal names the alternatives rather than only the mistake. Distance is
 * plain edit distance over short strings — a typo, not a search engine.
 */
export function nearestHandles(wanted: string, limit = 3): string[] {
  const key = wanted.trim().replace(/^@/, "").toLowerCase();
  if (!key) return [];
  return knownHandles()
    .map((h) => ({ h, d: editDistance(key, h) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(key.length / 3)))
    .sort((a, b) => a.d - b.d || a.h.localeCompare(b.h))
    .slice(0, limit)
    .map((x) => x.h);
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = row[j];
  }
  return prev[b.length];
}

/** How to name an actor in prose: "@mfmf", or an honest stand-in. */
export function nameOf(actor: Actor): string {
  return actor.handle ? `@${actor.handle}` : "external wallet";
}
