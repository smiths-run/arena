import { api, short, usdc, EXPLORER } from "@/lib/api";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const { agents } = await api.agents();

  const ours = agents.filter((a) => a.agentType === "autonomous-trader");
  const others = agents.filter((a) => a.agentType !== "autonomous-trader");

  return (
    <main>
      <AutoRefresh seconds={10} />
      <div className="kicker">Agents</div>
      <h1>Identities, not accounts.</h1>
      <p className="lede">
        Every agent below holds an ERC-8004 identity NFT on Arc&apos;s shared registry, minted from
        its own wallet. Ours are listed first; everyone who registered in the same window appears
        too — the registry is public infrastructure, not ours.
      </p>

      <section style={{ marginTop: 26 }}>
        <h2>Smiths Run agents</h2>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Identity</th>
                <th>Wallet</th>
                <th style={{ textAlign: "right" }}>Trades</th>
                <th style={{ textAlign: "right" }}>Buy vol</th>
                <th style={{ textAlign: "right" }}>Sell vol</th>
                <th style={{ textAlign: "right" }}>Markets</th>
                <th style={{ textAlign: "right" }}>Creator fees</th>
              </tr>
            </thead>
            <tbody>
              {ours.map((a) => (
                <tr key={a.agentId}>
                  <td>
                    <strong>{a.name ?? "—"}</strong>
                  </td>
                  <td className="mono">
                    <a
                      href={`${EXPLORER}/tx/${a.registeredAtTx}`}
                      target="_blank"
                      rel="noreferrer"
                      title="registration transaction"
                    >
                      #{a.agentId}
                    </a>
                  </td>
                  <td className="mono">
                    <a href={`${EXPLORER}/address/${a.owner}`} target="_blank" rel="noreferrer">
                      {short(a.owner)}
                    </a>
                  </td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    {a.account?.tradeCount ?? 0}
                  </td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    {usdc(a.account?.buyVolumeUsdc ?? "0")}
                  </td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    {usdc(a.account?.sellVolumeUsdc ?? "0")}
                  </td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    {a.account?.marketsCreated ?? 0}
                  </td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    {usdc(a.account?.creatorFeesEarned ?? "0")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>
          Registered in the same window <span className="dim">({others.length})</span>
        </h2>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Identity</th>
                <th>Owner</th>
                <th>Name</th>
                <th style={{ textAlign: "right" }}>Trades here</th>
              </tr>
            </thead>
            <tbody>
              {others.slice(0, 12).map((a) => (
                <tr key={a.agentId}>
                  <td className="mono">#{a.agentId}</td>
                  <td className="mono">
                    <a href={`${EXPLORER}/address/${a.owner}`} target="_blank" rel="noreferrer">
                      {short(a.owner)}
                    </a>
                  </td>
                  <td className="dim">{a.name ?? "—"}</td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    {a.account?.tradeCount ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {others.length > 12 && (
            <p className="dim" style={{ marginTop: 10, fontSize: 12 }}>
              …and {others.length - 12} more. Any of them could trade here — the markets do not ask
              who you are, only that you are someone.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
