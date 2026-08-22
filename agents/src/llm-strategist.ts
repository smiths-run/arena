/**
 * The LLM proposer. Plugs into the same Strategist seam as the heuristic and
 * changes nothing about who holds authority: the model proposes, proposal.ts
 * validates the shape against observed state, and the policy engine judges the
 * result exactly as it judges a heuristic proposal.
 *
 * Inference is a cost like any other, so it is bounded like any other:
 *   - a per-agent daily call cap, counted in the ledger, after which the agent
 *     runs on the heuristic instead of silently spending more
 *   - every call's token usage recorded, so the spend is a number, not a vibe
 *
 * And it is an enhancement, not a dependency: no key, cap reached, API down,
 * refusal, malformed output — every path degrades to the heuristic strategist
 * with the reason logged. The economy never halts because a model did.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Strategist } from "./strategist.ts";
import { heuristicStrategist } from "./strategist.ts";
import { PROPOSAL_SCHEMA, buildPrompt, toAction, type Proposal } from "./proposal.ts";
import * as obs from "./observe.ts";
import * as store from "./store.ts";
import { apiKey, classify, keyShape } from "./inference.ts";
import { shouldThink } from "./attention.ts";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
/** Depth of reasoning per call; "low" keeps a 60s-cooldown loop affordable. */
const EFFORT = (process.env.ANTHROPIC_EFFORT ?? "low") as "low" | "medium" | "high";

let client: Anthropic | null = null;

export const llmStrategist: Strategist = async (input) => {
  const log = (msg: string) => console.log(`[${input.agentName}] ${msg}`);

  if (!process.env.ANTHROPIC_API_KEY) {
    // Recorded, not just skipped: an agent running on its heuristic because
    // nobody configured a key looks exactly like one that chose not to think.
    store.llmFailureRecord(input.agentName, "no_key", "ANTHROPIC_API_KEY is not set");
    return heuristicStrategist(input);
  }
  // A quota paced thinking before this, and a quota is not a schedule: the
  // allowance went in the first two hours of the day and the agent was blind
  // for the rest. Now the world decides when a thought is worth buying.
  const attention = shouldThink({
    agentName: input.agentName,
    address: input.address,
    strategy: input.strategy,
    wakeReason: input.wakeReason,
  });
  if (!attention.think) {
    log(`not thinking — ${attention.reason}; heuristic takes over`);
    return heuristicStrategist(input);
  }
  const calls = store.llmCallsLast24h(input.agentName);
  log(`thinking — ${attention.reason} (${calls + 1}/${input.strategy.llm.maxCallsPerDay} today)`);

  try {
    // Cleaned rather than read raw: a stray newline in the dashboard is
    // indistinguishable from a revoked key once Anthropic answers 401.
    client ??= new Anthropic({ apiKey: apiKey() });

    const positions = store.positionsOf(input.agentName);
    const valued = await Promise.all(
      positions.map(async (p) => ({
        ...p,
        valueUsdc: p.tokens > 0n ? (await obs.quoteSell(p.marketId, p.tokens)).usdcOut : 0n,
      })),
    );
    const claimable = input.strategy.allowedActions.includes("claim")
      ? await obs.claimableFees(input.address)
      : [];

    const { system, user } = buildPrompt(input, {
      description: input.description,
      wakeReason: input.wakeReason,
      rules: store.rulesOf(input.agentName).filter((r) => r.enabled === 1).map((r) => r.text),
      positions: valued,
      claimable,
    });

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: {
        // Haiku-tier models reject the effort parameter; everything else gets it.
        ...(MODEL.includes("haiku") ? {} : { effort: EFFORT }),
        format: { type: "json_schema", schema: PROPOSAL_SCHEMA },
      },
    });

    // input_tokens excludes anything the cache served, and cached tokens are
    // billed at their own rates — recording only the first number is how a cost
    // report understates exactly the calls the cache was added to make cheap.
    store.llmCallRecord(
      input.agentName,
      MODEL,
      res.usage.input_tokens,
      res.usage.output_tokens,
      res.usage.cache_creation_input_tokens ?? 0,
      res.usage.cache_read_input_tokens ?? 0,
    );
    store.llmFailureClear(input.agentName);
    log(
      `llm ${MODEL} call ${calls + 1}/${input.strategy.llm.maxCallsPerDay} — ` +
        `${res.usage.input_tokens} in / ${res.usage.output_tokens} out`,
    );

    if (res.stop_reason !== "end_turn") {
      throw new Error(`llm stopped with ${res.stop_reason}`);
    }
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!text) throw new Error("llm returned no text block");

    const proposal = JSON.parse(text.text) as Proposal;
    return toAction(proposal, {
      validMarketIds: new Set(input.markets.map((m) => m.id)),
      positions,
      claimable,
      strategy: input.strategy,
    });
  } catch (err) {
    const { kind, detail } = classify(err);
    // The health endpoint reads the API process's environment, but this runs in
    // the orchestrator's. When they disagree about the key, only this side ever
    // sees it, so an auth failure carries its own view of the key's shape.
    const shape = kind === "auth" || kind === "no_key" ? keyShape() : null;
    store.llmFailureRecord(
      input.agentName,
      kind,
      shape ? `${detail} [worker key: ${JSON.stringify(shape)}]` : detail,
    );
    log(`llm strategist failed (${kind}), heuristic takes over — ${detail}`);
    return heuristicStrategist(input);
  }
};
