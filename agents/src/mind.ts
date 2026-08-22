/**
 * The mind desk — thinking, sold by the thought.
 *
 *   npm run mind        # http://localhost:42072
 *
 * An agent pays gas out of its own wallet, pays for a trade out of its own
 * wallet, and pays another agent for a report out of its own Gateway balance.
 * It has never paid for the one thing it does most: think. The model runs on
 * the platform's API key, so the largest running cost of an agent sits outside
 * the ledger its receipts are proudest of.
 *
 * This is the other side of that trade. One paid endpoint: a request without
 * payment gets 402 and a price, a request carrying a valid x402 authorization
 * gets a completion. The money leaves the agent's Gateway balance, which equity
 * already measures, so the cost lands in its net result with no new accounting
 * — the derivation in equity.ts simply becomes true again.
 *
 * The desk holds the API key. Agents never see it, and no agent can spend more
 * on thinking than its own wallet holds.
 *
 * It keeps no ledger. A desk is a separate service with a separate database,
 * so anything it wrote would land where nobody reading the platform's cost
 * report could see it. The buyer records the call, in the process that shares
 * the ledger with everything else the agent does — and it is the buyer's
 * spending, so it belongs on the buyer's record anyway.
 *
 * A note on what testnet proves. The agent pays in testnet USDC and the desk
 * pays Anthropic in real money, so this loop is real in its mechanism and
 * circular in its economics: the 402, the authorization, the Circle signature,
 * the Gateway settlement and the falling balance are all genuine, while the
 * value moved is not. On mainnet the loop opens — visitors fund their agents
 * with their own money — and the desk becomes the platform's largest revenue
 * line, because thinking happens far more often than trading.
 */
import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { apiKey, classify, keyShape } from "./inference.ts";

const PORT = Number(process.env.MIND_PORT ?? 42072);
const PRICE = process.env.MIND_PRICE ?? "$0.01";
const ARC_TESTNET_CAIP2 = "eip155:5042002";

/**
 * Who gets paid for thinking.
 *
 * Deliberately not defaulted to one of the trading agents. Net result is a
 * public ranking of how well an agent trades, and an agent that also collected
 * the platform's inference revenue would top that table without trading at all.
 * This belongs to a treasury identity — the side that will pay the real
 * Anthropic bill when the loop opens on mainnet — so it has to be named
 * explicitly rather than borrowed from whoever happened to be free.
 */
const SELLER = process.env.MIND_DESK_ADDRESS;
if (!SELLER) {
  throw new Error(
    "MIND_DESK_ADDRESS is not set. The mind desk needs its own payee address — " +
      "use a treasury identity, not a trading agent, or its inference revenue " +
      "will be counted as trading performance.",
  );
}

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
const MAX_TOKENS = Number(process.env.MIND_MAX_TOKENS ?? 4096);

const gateway = createGatewayMiddleware({
  sellerAddress: SELLER,
  networks: [ARC_TESTNET_CAIP2],
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  description: "Smiths Run inference desk: one bounded model call, priced per thought.",
});

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    service: "Smiths Run mind desk",
    payee: SELLER,
    network: ARC_TESTNET_CAIP2,
    price: PRICE,
    model: MODEL,
    endpoint: "POST /think",
    accepts: { system: "string", user: "string", schema: "object (optional)", effort: "string (optional)" },
  });
});

/**
 * Refuse before charging, not after.
 *
 * The paywall settles payment before the handler runs, so a desk that cannot
 * think leaves the buyer paid-up and empty-handed. Everything knowable before
 * the money moves is checked here: the request has a prompt, and the desk holds
 * a credential that at least has the shape of one that works.
 *
 * It cannot make the desk infallible — Anthropic can still refuse a key that
 * looked fine — and that case is logged as a debt below rather than vanishing
 * into a 502.
 */
const answerable: express.RequestHandler = (req, res, next) => {
  const body = req.body as { system?: unknown; user?: unknown } | undefined;
  if (typeof body?.user !== "string" || body.user.trim() === "") {
    res.status(400).json({ error: "a thought needs a user prompt", charged: false });
    return;
  }
  const shape = keyShape();
  if (!shape) {
    console.log("refused before charging: the desk has no API key");
    res.status(503).json({ error: "the desk is not configured to think right now", charged: false });
    return;
  }
  if (shape.credential === "oauth") {
    console.log("refused before charging: the desk holds an OAuth token, not an API key");
    res.status(503).json({ error: "the desk is not configured to think right now", charged: false });
    return;
  }
  next();
};

let client: Anthropic | null = null;

app.post("/think", answerable, gateway.require(PRICE), async (req, res) => {
  const payment = (req as { payment?: Record<string, unknown> }).payment;
  const body = req.body as {
    system?: string;
    user: string;
    schema?: Record<string, unknown>;
    effort?: string;
    agent?: string;
  };

  try {
    client ??= new Anthropic({ apiKey: apiKey() });

    const res2 = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      ...(body.system
        ? { system: [{ type: "text" as const, text: body.system, cache_control: { type: "ephemeral" as const } }] }
        : {}),
      messages: [{ role: "user", content: body.user }],
      ...(body.schema || body.effort
        ? {
            output_config: {
              ...(body.effort && !MODEL.includes("haiku") ? { effort: body.effort } : {}),
              ...(body.schema ? { format: { type: "json_schema" as const, schema: body.schema } } : {}),
            },
          }
        : {}),
    } as Parameters<Anthropic["messages"]["create"]>[0]);

    const message = res2 as Anthropic.Message;

    if (payment?.verified) {
      console.log(
        `sold a thought to ${payment.payer} for ${payment.amount} ` +
          `(settlement ${payment.transaction}) — ${message.usage.input_tokens} in / ` +
          `${message.usage.output_tokens} out`,
      );
    }

    const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    res.json({
      text: text?.text ?? "",
      stopReason: message.stop_reason,
      // Named so the buyer prices what actually answered, not what it assumed.
      model: MODEL,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
      },
      paidBy: payment?.payer ?? null,
    });
  } catch (err) {
    const { kind, detail } = classify(err);
    const owed = Boolean(payment?.verified);
    if (owed) {
      // Not merely an error: the buyer has already paid. Say so loudly enough
      // that it can be made good, rather than letting a bare 502 imply that
      // nothing was taken.
      console.error(
        `PAID BUT UNDELIVERED — payer ${payment?.payer}, settlement ${payment?.transaction}, ` +
          `kind ${kind}: ${detail}`,
      );
    }
    res.status(502).json({ error: detail, kind, charged: owed });
  }
});

app.listen(PORT, () => {
  console.log(`mind desk on http://localhost:${PORT}`);
  console.log(`  payee    ${SELLER}`);
  console.log(`  network  ${ARC_TESTNET_CAIP2}`);
  console.log(`  price    ${PRICE} per thought`);
  console.log(`  model    ${MODEL}`);
});
