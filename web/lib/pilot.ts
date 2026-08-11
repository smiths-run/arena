/**
 * The pilot: what makes an agent run.
 *
 * Smiths does not host visitor agents. An agent flies only while its
 * operator's browser tab is open — the tab holds a pilot grant (one wallet
 * signature, 24h) and ticks the server on the agent's cooldown. Close the
 * tab and the agent is on the ground; custody never moves.
 */
import type { Address } from "viem";
import { signMessage } from "./wallet";

export interface PilotGrant {
  expiry: number;
  signature: string;
}

const key = (owner: string) => `smiths-pilot-${owner.toLowerCase()}`;

export function loadGrant(owner: Address): PilotGrant | null {
  try {
    const raw = localStorage.getItem(key(owner));
    if (!raw) return null;
    const g = JSON.parse(raw) as PilotGrant;
    // A grant about to lapse is as good as lapsed — re-sign instead of
    // failing a tick mid-flight.
    if (!g?.signature || !Number.isFinite(g.expiry) || g.expiry < Date.now() + 60_000) return null;
    return g;
  } catch {
    return null;
  }
}

export async function createGrant(owner: Address): Promise<PilotGrant> {
  const expiry = Date.now() + 24 * 3600 * 1000;
  const signature = await signMessage(
    owner,
    `Smiths Run: pilot ${owner.toLowerCase()} until ${expiry}`,
  );
  const grant = { expiry, signature };
  try {
    localStorage.setItem(key(owner), JSON.stringify(grant));
  } catch {
    /* private mode — the grant still works for this tab's lifetime */
  }
  return grant;
}

export function dropGrant(owner: Address): void {
  try {
    localStorage.removeItem(key(owner));
  } catch {
    /* nothing to drop */
  }
}

export interface TickResult {
  ran: boolean;
  reason?: string;
  nextInSeconds?: number;
  run?: { id: number; outcome: string; action_kind: string | null; reason: string | null };
  error?: string;
}

/**
 * The grant, carried on a private read.
 *
 * Headers rather than query parameters: a credential in a URL ends up in
 * server logs and browser history, and the things these headers unlock — the
 * conversation, the rules, who the agent follows — are the operator's alone.
 */
export function grantHeaders(owner: Address, grant: PilotGrant): Record<string, string> {
  return {
    "x-smiths-owner": owner,
    "x-smiths-expiry": String(grant.expiry),
    "x-smiths-signature": grant.signature,
  };
}

/**
 * "I am still here, and did anything happen?"
 *
 * This is the whole of what keeps a visitor agent reachable by an event. While
 * the tab asks, its agents count as awake and a trigger can fire for them; when
 * it stops, events pass them by and are recorded as missed rather than queued.
 * The call is a pair of indexed reads on the server, so it is cheap enough to
 * make every few seconds — which is what keeps a reaction near the thing it is
 * reacting to.
 */
export async function heartbeat(
  owner: Address,
  grant: PilotGrant,
): Promise<{ agents: string[]; awake: string[] }> {
  const res = await fetch("/api/runs/pilot/pending", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner, expiry: grant.expiry, signature: grant.signature }),
  });
  const body = (await res.json()) as { agents?: string[]; awake?: string[]; error?: string };
  if (res.status === 403) throw new Error(body.error ?? "pilot grant rejected");
  return { agents: body.agents ?? [], awake: body.awake ?? [] };
}

export async function tick(owner: Address, handle: string, grant: PilotGrant): Promise<TickResult> {
  const res = await fetch("/api/runs/agent/tick", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner, handle, expiry: grant.expiry, signature: grant.signature }),
  });
  const body = (await res.json()) as TickResult;
  if (res.status === 403) throw new Error(body.error ?? "pilot grant rejected");
  return body;
}
