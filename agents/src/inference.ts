/**
 * What thinking costs.
 *
 * Every model call an agent makes is already written to the ledger — model,
 * tokens in, tokens out — because inference was always meant to be a cost like
 * any other. What was missing is the second half: turning that measurement into
 * money and putting it somewhere anyone can look at.
 *
 * This module does only that. It prices the calls that have already happened.
 * It does not move money, and nothing here is charged to an agent's wallet yet:
 * today the platform's own API key pays the bill, so an agent's net result — the
 * difference between its opening and closing equity — does not include what it
 * spent on thinking. That is a real gap in an otherwise complete ledger, and
 * naming it precisely is the first step to closing it.
 *
 * The prices below are the platform's own cost, in dollars per million tokens,
 * as published by Anthropic. They are not what an agent will be charged. When
 * the inference desk exists it will quote a price per call, the way the report
 * desk quotes a price per report, and the difference between that price and
 * these numbers is the desk's margin. Setting that price is a decision that
 * needs this measurement to exist first, which is why this ships on its own.
 */
import * as store from "./store.ts";

/** Dollars per million tokens, by model. */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5.0, out: 25.0 },
  "claude-opus-4-8": { in: 5.0, out: 25.0 },
  "claude-opus-4-7": { in: 5.0, out: 25.0 },
  "claude-opus-4-6": { in: 5.0, out: 25.0 },
  "claude-sonnet-5": { in: 3.0, out: 15.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-fable-5": { in: 10.0, out: 50.0 },
};

/**
 * The price used when a model is not in the table.
 *
 * An unknown model is far more likely to be a new frontier model than a cheap
 * one, so the fallback is the most expensive row rather than zero. A cost
 * report that quietly under-counts is worse than one that is visibly
 * pessimistic.
 */
const FALLBACK = { in: 10.0, out: 50.0 };

export function priceOf(model: string): { in: number; out: number } {
  return PRICES[model] ?? FALLBACK;
}

/** Whether the price came from the table or from the pessimistic fallback. */
export function isPriced(model: string): boolean {
  return model in PRICES;
}

/**
 * What a call cost, in USDC base units.
 *
 * Rounded up: a sub-unit call still costs something, and reporting it as zero
 * is how a ledger starts lying about small numbers at scale.
 */
export function costOf(model: string, tokensIn: number, tokensOut: number): bigint {
  const p = priceOf(model);
  const usd = (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out;
  return BigInt(Math.ceil(usd * 1e6));
}

export interface ModelUsage {
  model: string;
  priced: boolean;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsdc: string;
}

export interface AgentUsage {
  agent: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsdc: string;
  /** What the agent's own ledger says it made over the same window. */
  netResultUsdc: string;
  /** Net result with the thinking it did in this window taken out of it. */
  netOfInferenceUsdc: string;
}

export interface UsageReport {
  sinceMs: number;
  /** null when the window is "everything ever", where an hour count is noise. */
  windowHours: number | null;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsdc: string;
  costPerCallUsdc: string;
  byModel: ModelUsage[];
  byAgent: AgentUsage[];
  /**
   * Said once, in the response, so that nobody reading this endpoint can come
   * away believing the cost below is already reflected in an agent's receipts.
   */
  note: string;
}

const NOTE =
  "Measured, not charged. The platform's own API key pays for inference today, " +
  "so this cost does not leave an agent's wallet and is not included in the net " +
  "result on its receipts. netOfInference shows what the net result would be if " +
  "it were.";

/** Price every call in the window and group it two ways. */
export function usage(sinceMs: number, nowMs = Date.now()): UsageReport {
  const rows = store.llmUsage(sinceMs);
  const nets = new Map(store.netResultByAgent().map((n) => [n.agent, BigInt(n.net)]));

  const models = new Map<string, ModelUsage>();
  const agents = new Map<string, { calls: number; tokensIn: number; tokensOut: number; cost: bigint }>();
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0n;

  for (const r of rows) {
    const c = costOf(r.model, r.tokensIn, r.tokensOut);
    calls += r.calls;
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
    cost += c;

    const m = models.get(r.model) ?? {
      model: r.model, priced: isPriced(r.model), calls: 0, tokensIn: 0, tokensOut: 0, costUsdc: "0",
    };
    m.calls += r.calls;
    m.tokensIn += r.tokensIn;
    m.tokensOut += r.tokensOut;
    m.costUsdc = (BigInt(m.costUsdc) + c).toString();
    models.set(r.model, m);

    const a = agents.get(r.agent) ?? { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0n };
    a.calls += r.calls;
    a.tokensIn += r.tokensIn;
    a.tokensOut += r.tokensOut;
    a.cost += c;
    agents.set(r.agent, a);
  }

  return {
    sinceMs,
    windowHours: sinceMs === 0 ? null : Math.round(((nowMs - sinceMs) / 3_600_000) * 10) / 10,
    calls,
    tokensIn,
    tokensOut,
    costUsdc: cost.toString(),
    costPerCallUsdc: calls > 0 ? (cost / BigInt(calls)).toString() : "0",
    byModel: [...models.values()].sort((a, b) => Number(BigInt(b.costUsdc) - BigInt(a.costUsdc))),
    byAgent: [...agents.entries()]
      .map(([agent, a]) => {
        const net = nets.get(agent) ?? 0n;
        return {
          agent,
          calls: a.calls,
          tokensIn: a.tokensIn,
          tokensOut: a.tokensOut,
          costUsdc: a.cost.toString(),
          netResultUsdc: net.toString(),
          netOfInferenceUsdc: (net - a.cost).toString(),
        };
      })
      .sort((a, b) => Number(BigInt(b.costUsdc) - BigInt(a.costUsdc))),
    note: NOTE,
  };
}
