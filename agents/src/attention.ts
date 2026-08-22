/**
 * When an agent is worth waking the model for.
 *
 * Thinking used to be paced by a daily quota, and a quota is not a schedule.
 * anvil's allowance of 150 was spent between 02:00 and 04:39 one morning and it
 * ran blind for the twenty hours that followed — the most expensive hours of
 * the day going to the cheapest question ("has anything changed?") asked over
 * and over into an empty market, and the rest of the day going unthought.
 *
 * The fix is not a longer cooldown, which only spreads the same blindness more
 * evenly. It is to ask the cheap question cheaply, in code, and to spend a
 * thought only when the answer is yes. The platform already keeps a canonical
 * record of everything that happens on it, so "has anything changed since I
 * last looked?" is one indexed count, not a judgement call.
 *
 * Three things wake an agent:
 *
 *   Something happened. Any launch or trade by somebody else since its last
 *   thought — including in a market it holds, which is why no separate
 *   position check is needed.
 *
 *   Something woke it on purpose. A run carrying a wake reason is answering a
 *   specific event and must not answer it with a heuristic.
 *
 *   It has been quiet too long. A floor, so that an economy where nothing
 *   happens does not produce an agent that never thinks again. This is the one
 *   rule that costs money for nothing, and it is deliberately sparse.
 *
 * Everything else runs on the heuristic, which is not a downgrade: with nothing
 * new in the world, the model was being asked to re-derive the same answer from
 * the same inputs.
 */
import type { Strategy } from "./config.ts";
import * as store from "./store.ts";

/**
 * How long an agent may go without thinking when the world is silent.
 *
 * Sparse on purpose. In a quiet economy this is the only rule that fires, so it
 * sets the floor of the bill: at two hours an agent thinks twelve times a day
 * and costs about a tenth of a dollar, against the one dollar fourteen a spent
 * quota was costing to be blind most of the time.
 */
export const QUIET_FLOOR_MS = 2 * 3_600_000;

export interface Attention {
  think: boolean;
  /** Why, in words that belong in a log line a human will read at 3am. */
  reason: string;
}

export interface AttentionInput {
  agentName: string;
  address: string;
  strategy: Strategy;
  /** Set when something specific woke this run, e.g. a trigger firing. */
  wakeReason?: string;
}

/**
 * Whether this run should reach for the model.
 *
 * The order matters. The budget is checked first because an agent that has
 * spent its allowance must not think however interesting the world became; the
 * wake reason is checked before the event count because a run that exists to
 * answer something must answer it even if the ledger has not caught up.
 */
export function shouldThink(input: AttentionInput, now = Date.now()): Attention {
  const cap = input.strategy.llm.maxCallsPerDay;
  const spent = store.llmCallsLast24h(input.agentName);
  if (spent >= cap) {
    return { think: false, reason: `daily thinking budget spent (${spent}/${cap})` };
  }

  if (input.wakeReason) {
    return { think: true, reason: `woken on purpose: ${input.wakeReason}` };
  }

  const last = store.llmLastCallAtFor(input.agentName);
  if (last === null) {
    return { think: true, reason: "first look" };
  }

  const moved = store.eventsCountSince(last, input.address);
  if (moved > 0) {
    return {
      think: true,
      reason: `${moved} event${moved === 1 ? "" : "s"} since the last look`,
    };
  }

  const quiet = now - last;
  if (quiet >= QUIET_FLOOR_MS) {
    return { think: true, reason: `nothing has happened for ${minutes(quiet)}; looking anyway` };
  }

  return {
    think: false,
    reason: `nothing has happened since the last look ${minutes(quiet)} ago`,
  };
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round((m / 60) * 10) / 10;
  return `${h}h`;
}
