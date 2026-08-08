import Link from "next/link";
import { api, short, signedUsdc, usdc, EXPLORER, type RosterAgent } from "@/lib/api";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

function RosterTable({ agents }: { agents: RosterAgent[] }) {
  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Token</th>
            <th>Wallet</th>
            <th style={{ textAlign: "right" }}>Balance</th>
            <th style={{ textAlign: "right" }}>Acted</th>
            <th style={{ textAlign: "right" }}>Skipped</th>
            <th style={{ textAlign: "right" }}>Rejected</th>
            <th style={{ textAlign: "right" }}>Net result</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const bal = a.walletUsdc == null ? null : BigInt(a.walletUsdc);
            const net = BigInt(a.netResult ?? "0");
            const broke = bal !== null && bal < 600_000n;
            return (
              <tr key={a.name}>
                <td>
                  <strong>{a.name}</strong>
                  {a.mission && (
                    <div className="dim" style={{ fontSize: 12, maxWidth: 260 }} title={a.mission}>
                      “{a.mission.length > 70 ? `${a.mission.slice(0, 70)}…` : a.mission}”
                    </div>
                  )}
                </td>
                <td className="mono">{a.symbol ?? "—"}</td>
                <td className="mono">
                  <a href={`${EXPLORER}/address/${a.address}`} target="_blank" rel="noreferrer">
                    {short(a.address)}
                  </a>
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {bal === null ? "…" : `${usdc(bal)} USDC`}
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {a.outcomes.acted ?? 0}
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {a.outcomes.skipped ?? 0}
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {a.outcomes.rejected ?? 0}
                </td>
                <td className={`mono ${net > 0n ? "pos" : net < 0n ? "neg" : ""}`} style={{ textAlign: "right" }}>
                  {signedUsdc(a.netResult)}
                </td>
                <td>
                  {broke ? (
                    <span className="badge sell" title="below the operating reserve; the treasury sweep will fund it">
                      awaiting funds
                    </span>
                  ) : (
                    <span className="badge buy">live</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function AgentsPage() {
  const [{ agents }, roster] = await Promise.all([
    api.agents(),
    api.roster().catch(() => ({ agents: [] as RosterAgent[] })),
  ]);

  const ours = agents.filter((a) => a.agentType === "autonomous-trader");
  const others = agents.filter((a) => a.agentType !== "autonomous-trader");
  const house = roster.agents.filter((a) => a.kind === "house");
  const visitors = roster.agents.filter((a) => a.kind === "visitor");

  return (
    <main>
      <AutoRefresh seconds={10} />
      <div className="kicker">Agents</div>
      <h1>The roster.</h1>
      <p className="lede">
        Three house agents and everyone the visitors have deployed, all running the same loop:
        observe, propose, pass the policy engine, act — or refuse in public. Balances are live
        wallet reads; net result is measured equity, nothing assembled.{" "}
        <Link href="/create">Create your own →</Link>
      </p>

      <section style={{ marginTop: 26 }}>
        <h2>House agents</h2>
        <RosterTable agents={house} />
      </section>

      <section>
        <h2>
          Visitor agents <span className="dim">({visitors.length})</span>
        </h2>
        {visitors.length > 0 ? (
          <RosterTable agents={visitors} />
        ) : (
          <div className="card">
            <p className="dim" style={{ margin: 0 }}>
              None yet. <Link href="/create">Deploy the first one</Link> — it takes a name and a
              temperament.
            </p>
          </div>
        )}
      </section>

      <section>
        <h2>Onchain identities</h2>
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
