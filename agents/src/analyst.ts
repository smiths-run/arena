/**
 * bellows — the analyst agent's report desk.
 *
 *   npm run analyst        # http://localhost:42071
 *
 * One paid endpoint. A request without payment gets HTTP 402 and a price; a
 * request carrying a valid x402 authorization gets the report. Circle Gateway
 * batches settlement, so the buyer spends no gas and the payment clears in one
 * round trip.
 *
 * Income is recorded against bellows' own identity, so the receipts page can
 * show intelligence revenue next to trading revenue — the second economic loop
 * the product claims.
 */
import "dotenv/config";
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { AGENTS } from "./shared.ts";
import { buildReport, canBuildReport } from "./report.ts";
import * as store from "./store.ts";

const PORT = Number(process.env.ANALYST_PORT ?? 42071);
const PRICE = process.env.REPORT_PRICE ?? "$0.001";
const ARC_TESTNET_CAIP2 = "eip155:5042002";

const bellows = AGENTS.find((a) => a.name === "bellows");
if (!bellows) throw new Error("bellows is not configured");

const gateway = createGatewayMiddleware({
  sellerAddress: bellows.address,
  networks: [ARC_TESTNET_CAIP2],
  // Defaults to mainnet; testnet must be explicit.
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  description: "Smiths Run market intelligence: external demand, concentration, momentum.",
});

const app = express();

app.get("/", (_req, res) => {
  res.json({
    service: "bellows — Smiths Run analyst",
    agent: bellows.address,
    network: ARC_TESTNET_CAIP2,
    price: PRICE,
    endpoint: "/report/:marketId",
    describes: [
      "externalTraders",
      "externalTradeRatio",
      "topBuyerConcentration",
      "momentum",
      "creator track record",
      "risk + verdict",
    ],
  });
});

/** Free: what the report would cover, and nothing that answers the question. */
app.get("/preview/:marketId", async (req, res) => {
  try {
    const report = await buildReport(req.params.marketId);
    res.json({
      marketId: report.marketId,
      symbol: report.symbol,
      tradeCount: report.tradeCount,
      paidFieldsWithheld: [
        "externalTraders",
        "topBuyerConcentration",
        "momentum",
        "risk",
        "verdict",
        "findings",
      ],
      price: PRICE,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Refuse before charging, not after.
 *
 * `gateway.require` settles the payment before the handler runs, so a report
 * that cannot be built leaves the buyer paid-up and empty-handed. This guard
 * sits in front of the paywall and turns the two realistic failures — an
 * unknown market, an upstream that is down — into an honest 404 or 503 that
 * costs nobody anything.
 *
 * It does not make the desk infallible: something can still break between this
 * check and the report itself, and that case is logged loudly below so it can
 * be made good rather than disappearing into a 502.
 */
const feasible: express.RequestHandler<{ marketId: string }> = (req, res, next) => {
  canBuildReport(req.params.marketId)
    .then((v) => {
      if (v.ok) return next();
      console.log(`refused before charging: ${req.params.marketId} — ${v.reason}`);
      res.status(v.status).json({ error: v.reason, charged: false });
    })
    .catch(next);
};

app.get("/report/:marketId", feasible, gateway.require(PRICE), async (req, res) => {
  const payment = (req as { payment?: Record<string, unknown> }).payment;
  try {
    const report = await buildReport(req.params.marketId);

    if (payment?.verified) {
      store.intelSaleRecord({
        seller: bellows.address,
        payer: String(payment.payer ?? "unknown"),
        marketId: report.marketId,
        amountUsdc: BigInt(String(payment.amount ?? "0")),
        settlementRef: payment.transaction ? String(payment.transaction) : null,
      });
      console.log(
        `sold report on market ${report.marketId} to ${payment.payer} ` +
          `for ${payment.amount} (settlement ${payment.transaction})`,
      );
    }

    res.json({ ...report, paidBy: payment?.payer ?? null });
  } catch (err) {
    // Payment already cleared but the report failed: say so plainly rather than
    // returning a body that looks like analysis.
    console.error("report generation failed after payment:", err);
    res.status(502).json({
      error: "report unavailable",
      detail: err instanceof Error ? err.message : String(err),
      paidBy: payment?.payer ?? null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`analyst desk on http://localhost:${PORT}`);
  console.log(`  agent    ${bellows.name} ${bellows.address}`);
  console.log(`  network  ${ARC_TESTNET_CAIP2}`);
  console.log(`  price    ${PRICE} per report`);
});
