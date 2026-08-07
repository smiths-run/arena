/**
 * The one scheduling decision, as a pure function.
 *
 * Precedence is the whole content of this module, so it is stated once:
 *
 *   1. held      — a Circle transaction is in flight; nothing runs, not even an
 *                  operator request. The agent's position and spend are unknown
 *                  until it lands, and no authority changes that.
 *   2. requested — the operator asked for a run now. Overrides pause (the
 *                  operator is the one who paused it) and overrides cooldown.
 *   3. paused    — the operator stopped scheduled runs.
 *   4. cooldown  — the strategy's own pacing, ignored in --once mode where a
 *                  single manual pass is the point.
 */
export interface ScheduleInput {
  /** A Circle transaction for this agent is still unresolved. */
  held: boolean;
  /** An unconsumed operator run request exists. */
  requested: boolean;
  /** The operator has paused scheduled runs for this agent. */
  paused: boolean;
  /** --once: one manual pass over every agent, cooldowns do not apply. */
  once: boolean;
  sinceLastRunMs: number;
  cooldownMs: number;
}

export type ScheduleDecision =
  | { run: true; trigger: "operator" | "manual" | "schedule" }
  | { run: false; why: "held" | "paused" | "cooldown" };

export function decide(input: ScheduleInput): ScheduleDecision {
  if (input.held) return { run: false, why: "held" };
  if (input.requested) return { run: true, trigger: "operator" };
  if (input.paused) return { run: false, why: "paused" };
  if (input.once) return { run: true, trigger: "manual" };
  if (input.sinceLastRunMs < input.cooldownMs) return { run: false, why: "cooldown" };
  return { run: true, trigger: "schedule" };
}
