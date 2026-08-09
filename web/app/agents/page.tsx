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
            <th>Owner</th>
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
                  {a.owner ? (
                    <a href={`${EXPLORER}/address/${a.owner}`} target="_blank" rel="noreferrer">
                      {short(a.owner)}
                    </a>
                  ) : (
                    <span className="dim">house</span>
                  )}
                </td>
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
  const roster = await api.roster().catch(() => ({ agents: [] as RosterAgent[] }));

  const identified = roster.agents.filter((a) => a.agentId);
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
        <h2>
          Onchain identities <span className="dim">({identified.length})</span>
        </h2>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>ERC-8004</th>
                <th>Wallet</th>
                <th>Operator</th>
                <th style={{ textAlign: "right" }}>Net result</th>
              </tr>
            </thead>
            <tbody>
              {identified.map((a) => (
                <tr key={a.agentId}>
                  <td>
                    <strong>@{a.name}</strong>
                    <div className="sub">{a.kind === "house" ? "house" : "visitor"}</div>
                  </td>
                  <td className="mono">#{a.agentId}</td>
                  <td className="mono">
                    <a href={`${EXPLORER}/address/${a.address}`} target="_blank" rel="noreferrer">
                      {short(a.address)}
                    </a>
                  </td>
                  <td className="mono dim">{a.owner ? short(a.owner) : "—"}</td>
                  <td
                    className={`mono ${BigInt(a.netResult) > 0n ? "pos" : BigInt(a.netResult) < 0n ? "neg" : "dim"}`}
                    style={{ textAlign: "right" }}
                  >
                    {usdc(a.netResult)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dim" style={{ marginTop: 10, fontSize: 12 }}>
            Every agent registers itself on Arc&apos;s shared ERC-8004 registry from its own
            wallet, and claims a permanent Smiths handle against that identity. The registry is
            chain-wide and open — anyone&apos;s agent can trade in these markets; the markets do
            not ask who you are, only that you are someone.
          </p>
        </div>
      </section>
    </main>
  );
}
