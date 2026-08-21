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


// ── why thinking stops ──────────────────────────────────────────────────────

/**
 * What kind of failure this was, in one word.
 *
 * The distinction that matters operationally is not the stack trace, it is
 * whether somebody needs to top up an account, replace a key, or simply wait.
 * These are the answers to that question, and they are deliberately few.
 */
export type FailureKind =
  | "no_key"        // nothing configured; the model was never reached
  | "auth"          // the key was rejected
  | "credit"        // the account is out of money
  | "rate_limit"    // too many requests, for now
  | "overloaded"    // the model is busy, for now
  | "network"       // it never got there
  | "bad_response"  // it answered, but not with something usable
  | "other";

/** Plain English for each, in the present tense, for a human reading a status. */
const MEANING: Record<FailureKind, string> = {
  no_key: "no API key is configured on this deployment",
  auth: "the API key is being rejected",
  credit: "the Anthropic account is out of credit",
  rate_limit: "requests are being rate limited",
  overloaded: "the model is overloaded",
  network: "the request is not reaching Anthropic",
  bad_response: "the model answers but not in a usable shape",
  other: "calls are failing",
};

export function meaningOf(kind: string): string {
  return MEANING[kind as FailureKind] ?? MEANING.other;
}

/**
 * Sort an error into one of the kinds above.
 *
 * Status codes carry most of it; the out-of-credit case is the exception,
 * because Anthropic reports it as an ordinary 400 and only the message
 * distinguishes it from a malformed request. That one is worth catching
 * precisely: it is the difference between "somebody pay the bill" and
 * "somebody fix the code".
 */
export function classify(err: unknown): { kind: FailureKind; detail: string } {
  const e = err as { status?: number; message?: string; name?: string };
  const detail = (e?.message ?? String(err)).slice(0, 300);
  const msg = detail.toLowerCase();

  if (msg.includes("credit balance") || msg.includes("insufficient_quota") || msg.includes("billing")) {
    return { kind: "credit", detail };
  }
  switch (e?.status) {
    case 401:
    case 403:
      return { kind: "auth", detail };
    case 429:
      return { kind: "rate_limit", detail };
    case 529:
    case 503:
      return { kind: "overloaded", detail };
  }
  if (msg.includes("api key") || msg.includes("apikey")) return { kind: "auth", detail };
  if (
    e?.name === "APIConnectionError" ||
    e?.name === "APIConnectionTimeoutError" ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed")
  ) {
    return { kind: "network", detail };
  }
  if (msg.includes("stopped with") || msg.includes("no text block") || msg.includes("json")) {
    return { kind: "bad_response", detail };
  }
  return { kind: "other", detail };
}

/** True when a key is present at all. Never reveals any part of it. */
export function keyConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export interface Health {
  keyConfigured: boolean;
  lastCallAt: number | null;
  hoursSinceLastCall: number | null;
  failures: store.LlmFailure[];
  /** One sentence a human can act on without reading the rest. */
  state: string;
}

/**
 * Whether the agents are thinking, and if not, why not.
 *
 * This exists because the honest answer to "is inference working?" was, for a
 * week, unavailable to anyone who was not tailing the logs at the right moment.
 */
export function health(nowMs = Date.now(), quietHours = 6): Health {
  const configured = keyConfigured();
  const lastCallAt = store.llmLastCallAt();
  const failures = store.llmFailures();
  const hours = lastCallAt === null ? null : Math.round(((nowMs - lastCallAt) / 3_600_000) * 10) / 10;

  let state: string;
  if (!configured) {
    state = "Not thinking: " + MEANING.no_key + ". Every agent is running on its heuristic.";
  } else if (failures.length > 0) {
    const worst = failures.reduce((a, b) => (a.count >= b.count ? a : b));
    const since = new Date(worst.firstAt).toISOString().replace("T", " ").slice(0, 16);
    state =
      `Not thinking reliably: ${meaningOf(worst.kind)} — ${worst.count} failures ` +
      `since ${since} UTC. Agents fall back to their heuristic when a call fails.`;
  } else if (lastCallAt === null) {
    state = "No agent has ever called the model on this deployment.";
  } else if (hours !== null && hours > quietHours) {
    state =
      `A key is configured and nothing is failing, but no agent has thought for ${hours} hours. ` +
      "Either the daily caps are spent or the agents are not running.";
  } else {
    state = `Thinking normally; the last call was ${hours} hours ago.`;
  }

  return { keyConfigured: configured, lastCallAt, hoursSinceLastCall: hours, failures, state };
}
