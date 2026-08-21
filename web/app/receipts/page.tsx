import { api, signedUsdc, usdc, EXPLORER } from "@/lib/api";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

function when(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(5, 19);
}

export default async function ReceiptsPage() {
  const [{ runs }, { agents }] = await Promise.all([api.runs(60), api.netResult()]);

  const net = (r: (typeof runs)[number]) =>
    r.equity_open && r.equity_close
      ? (BigInt(r.equity_close) - BigInt(r.equity_open)).toString()
      : null;

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
      <p className="lede" style={{ marginTop: 10 }}>
        <strong>Net</strong> is the agent&apos;s whole equity — wallet, Gateway balance, claimable
        creator fees and the liquidation value of every position — measured before and after the
        run. Nothing external moves in between, so the difference cannot omit a cost that leaves
        the agent. One still does not: model inference is paid by the platform today, not by the
        agent, so Net does not yet include what it cost to think. Each row is signed by the
        agent&apos;s own wallet: edit any field and the signature stops verifying.
      </p>

      <div className="counters" style={{ marginTop: 24 }}>
        {agents.map((a) => (
          <div className="counter" key={a.agent}>
            <div className={`value ${BigInt(a.net) < 0n ? "neg" : ""}`}>{signedUsdc(a.net)}</div>
            <div className="label">
              {a.agent} · net over {a.runs} runs
            </div>
          </div>
        ))}
      </div>

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
                <th style={{ textAlign: "right" }}>Net</th>
                <th>Signed</th>
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
                  <td
                    className={`mono ${net(r) && BigInt(net(r)!) < 0n ? "neg" : net(r) && BigInt(net(r)!) > 0n ? "pos" : "dim"}`}
                    style={{ textAlign: "right" }}
                  >
                    {net(r) === null ? "—" : signedUsdc(net(r))}
                  </td>
                  <td className="mono dim" title={r.receipt_signature ?? "unsigned"}>
                    {r.receipt_signature ? `${r.receipt_signature.slice(0, 8)}…` : "—"}
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
