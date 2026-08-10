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

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
/** Depth of reasoning per call; "low" keeps a 60s-cooldown loop affordable. */
const EFFORT = (process.env.ANTHROPIC_EFFORT ?? "low") as "low" | "medium" | "high";

let client: Anthropic | null = null;

export const llmStrategist: Strategist = async (input) => {
  const log = (msg: string) => console.log(`[${input.agentName}] ${msg}`);

  if (!process.env.ANTHROPIC_API_KEY) {
    return heuristicStrategist(input);
  }
  const calls = store.llmCallsLast24h(input.agentName);
  if (calls >= input.strategy.llm.maxCallsPerDay) {
    log(`llm daily cap reached (${calls}/${input.strategy.llm.maxCallsPerDay}), heuristic takes over`);
    return heuristicStrategist(input);
  }

  try {
    client ??= new Anthropic();

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

    store.llmCallRecord(input.agentName, MODEL, res.usage.input_tokens, res.usage.output_tokens);
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
    log(`llm strategist failed, heuristic takes over — ${err instanceof Error ? err.message : err}`);
    return heuristicStrategist(input);
  }
};
