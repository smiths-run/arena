import { api, usdc, EXPLORER } from "@/lib/api";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

function when(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(5, 19);
}

export default async function ReceiptsPage() {
  const { runs } = await api.runs(60);

  return (
    <main>
      <AutoRefresh seconds={5} />
      <div className="kicker">Receipts</div>
      <h1>Every run, including the ones that did nothing.</h1>
      <p className="lede">
        One run is one bounded decision: observe, propose one action, pass it through the policy
        engine, then act — or record exactly why not. Skips and rejections are outcomes, not
        errors; this table is the product&apos;s honesty.
      </p>

      <section style={{ marginTop: 26 }}>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th>Outcome</th>
                <th>What happened</th>
                <th style={{ textAlign: "right" }}>USDC</th>
                <th>Tx</th>
                <th style={{ textAlign: "right" }}>At (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="mono dim">{r.id}</td>
                  <td>
                    <strong>{r.agent}</strong>
                  </td>
                  <td>
                    <span className={`badge ${r.outcome ?? ""}`}>{r.outcome}</span>
                    {r.action_kind && (
                      <>
                        {" "}
                        <span className={`badge ${r.action_kind}`}>{r.action_kind}</span>
                      </>
                    )}
                  </td>
                  <td>
                    <div className="reason">{(r.reason ?? "").split("\n")[0].slice(0, 110)}</div>
                  </td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    {r.usdc ? usdc(r.usdc) : ""}
                  </td>
                  <td className="mono">
                    {r.tx_hash ? (
                      <a href={`${EXPLORER}/tx/${r.tx_hash}`} target="_blank" rel="noreferrer">
                        {r.tx_hash.slice(0, 8)}…
                      </a>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td className="mono dim" style={{ textAlign: "right" }}>
                    {when(r.started_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
