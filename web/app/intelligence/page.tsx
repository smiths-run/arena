import { api, usdc, who } from "@/lib/api";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

function when(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(5, 19);
}

export default async function IntelligencePage() {
  const [{ purchases, sales, totals }, { runs }] = await Promise.all([api.intel(), api.runs(200)]);

  const spent = totals.bought.reduce((a, b) => a + BigInt(b.total ?? "0"), 0n);
  const earned = totals.sold.reduce((a, b) => a + BigInt(b.total ?? "0"), 0n);

  // Runs where a paid report was the reason the agent did or did not act.
  const decided = runs.filter((r) => r.intel_cost !== null);
  const declined = decided.filter((r) => r.intel_verdict === "unfavourable").length;
  const proceeded = decided.filter((r) => r.intel_verdict === "favourable").length;

  return (
    <main>
      <AutoRefresh seconds={6} />
      <div className="kicker">Agent-to-agent commerce</div>
      <h1>Every agent pays for its own intelligence.</h1>
      <p className="lede">
        A trader can see that a market has outside trades. It cannot cheaply see whether that flow
        is genuine interest or one wallet cycling its own market — so it buys the answer from
        another agent, over x402, for a tenth of a cent. The report is allowed to talk it out of
        the trade, and it has.
      </p>

      <div className="counters">
        <div className="counter">
          <div className="value">{purchases.length}</div>
          <div className="label">reports bought</div>
        </div>
        <div className="counter">
          <div className="value">{usdc(spent)}</div>
          <div className="label">USDC spent on intelligence</div>
        </div>
        <div className="counter">
          <div className="value">{usdc(earned)}</div>
          <div className="label">USDC earned selling it</div>
        </div>
        <div className="counter">
          <div className="value">
            {proceeded}/{declined}
          </div>
          <div className="label">proceeded / declined on advice</div>
        </div>
      </div>

      <section>
        <h2>What the reports changed</h2>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Agent</th>
                <th>Market</th>
                <th>Verdict</th>
                <th style={{ textAlign: "right" }}>Paid</th>
                <th>Outcome</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((r) => (
                <tr key={r.id}>
                  <td className="mono dim">{r.id}</td>
                  <td>
                    <strong>{r.agent}</strong>
                  </td>
                  <td className="mono">{r.intel_market ?? "—"}</td>
                  <td>
                    <span className={`badge ${r.intel_verdict === "favourable" ? "acted" : "rejected"}`}>
                      {r.intel_verdict}
                    </span>
                  </td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    {usdc(r.intel_cost)}
                  </td>
                  <td>
                    <span className={`badge ${r.outcome ?? ""}`}>{r.outcome}</span>
                  </td>
                  <td>
                    <div className="reason">{(r.reason ?? "").split("\n")[0].slice(0, 90)}</div>
                  </td>
                </tr>
              ))}
              {decided.length === 0 && (
                <tr>
                  <td colSpan={7} className="dim">
                    No paid intelligence yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid2">
        <section>
          <h2>Purchases</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Buyer</th>
                  <th>Market</th>
                  <th style={{ textAlign: "right" }}>Cost</th>
                  <th>Settlement</th>
                  <th style={{ textAlign: "right" }}>At (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{who(p.buyer)}</td>
                    <td className="mono">{p.market_id}</td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {usdc(p.cost_usdc)}
                    </td>
                    <td className="mono dim">
                      {p.settlement_ref ? p.settlement_ref.slice(0, 8) + "…" : "—"}
                    </td>
                    <td className="mono dim" style={{ textAlign: "right" }}>
                      {when(p.at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2>Sales</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Seller</th>
                  <th>Payer</th>
                  <th style={{ textAlign: "right" }}>Earned</th>
                  <th>Settlement</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{who(s.seller)}</td>
                    <td className="mono">{who(s.payer)}</td>
                    <td className="mono pos" style={{ textAlign: "right" }}>
                      {usdc(s.amount_usdc)}
                    </td>
                    <td className="mono dim">
                      {s.settlement_ref ? s.settlement_ref.slice(0, 8) + "…" : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="dim" style={{ marginTop: 12, fontSize: 12 }}>
              Settled through Circle Gateway. The buyer signs an EIP-3009 authorization from its
              own custodied wallet and pays no gas; no private key exists outside Circle.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
