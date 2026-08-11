"use client";

/**
 * Flying the fleet, from wherever the operator happens to be.
 *
 * A visitor agent runs while its operator is present, and an operator reading
 * their agent's chat is no less present than one watching the Run screen. When
 * this lived only on Run, an operator talking to their agent had a fleet the
 * server considered asleep — so an event another agent caused was recorded as
 * missed while its follower's operator sat two feet away. One loop, used by
 * every screen that knows who is connected, is the whole fix.
 *
 * The server stays the authority on cooldowns: a tick that lands early comes
 * back with "not yet" and when to return, so two open tabs cannot double-run an
 * agent between them.
 */
import { useEffect, useRef } from "react";
import type { Address } from "viem";
import { heartbeat, tick, type PilotGrant } from "./pilot";
import type { MyAgent } from "./api";

/**
 * Three seconds is the heartbeat, not the run cadence.
 *
 * The poll it makes is two indexed reads on the server and answers "nothing"
 * almost every time. What it buys is the gap between another agent acting and
 * this one hearing about it — which is the difference between reacting and
 * finding out later.
 */
const BEAT_MS = 3_000;

export function usePilot(opts: {
  account: Address | null;
  grant: PilotGrant | null;
  fleet: MyAgent[] | null;
  /** Called after a tick that actually ran, so the screen can refresh. */
  onRan?: () => void;
  /** Called when the grant is no longer accepted — it lapsed mid-flight. */
  onGrantLost?: () => void;
}): void {
  const { account, grant, fleet, onRan, onGrantLost } = opts;

  // Refs so the loop always reads the current fleet and callbacks without
  // being torn down and restarted every time the screen re-renders.
  const fleetRef = useRef<MyAgent[] | null>(fleet);
  fleetRef.current = fleet;
  const ranRef = useRef(onRan);
  ranRef.current = onRan;
  const lostRef = useRef(onGrantLost);
  lostRef.current = onGrantLost;
  const nextTickAt = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!account || !grant) return;
    let stopped = false;

    const fly = async () => {
      if (stopped) return;
      const running = (fleetRef.current ?? []).filter((f) => f.state === "running");

      // Say we are here, and find out whether anything happened that one of
      // these agents follows. An agent with work waiting jumps its cooldown:
      // it is answering something, not starting something.
      try {
        const { agents } = await heartbeat(account, grant);
        for (const handle of agents) nextTickAt.current[handle] = 0;
      } catch {
        lostRef.current?.();
        return;
      }

      for (const f of running) {
        if (stopped) return;
        if ((nextTickAt.current[f.handle] ?? 0) > Date.now()) continue;
        try {
          const r = await tick(account, f.handle, grant);
          nextTickAt.current[f.handle] = Date.now() + (r.nextInSeconds ?? 20) * 1000;
          if (r.ran) ranRef.current?.();
        } catch {
          // A rejected grant means it lapsed — land the fleet and ask for a
          // fresh signature instead of hammering the server.
          lostRef.current?.();
          return;
        }
      }
    };

    void fly();
    const t = setInterval(() => void fly(), BEAT_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [account, grant]);
}
