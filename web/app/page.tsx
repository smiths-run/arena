import Link from "next/link";
import { api, bps, usdc, usdcRounded, who, EXPLORER } from "@/lib/api";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

export default async function Arena() {
  // The chain says what exists; the indexer adds history to it where it has
  // caught up. Neither failing should blank the page.
  const [chain, indexed] = await Promise.all([
    api.chain().catch(() => ({ markets: [], recentTrades: [] })),
    api.markets().catch(() => ({ markets: [] })),
  ]);

  const historyOf = new Map(indexed.markets.map((m) => [m.id, m]));
  const markets = chain.markets.map((m) => ({
    ...m,
    name: historyOf.get(m.id)?.name ?? "",
    volumeUsdc: historyOf.get(m.id)?.volumeUsdc ?? null,
    tradeCount: historyOf.get(m.id)?.tradeCount ?? null,
  }));

  const curveTotal = chain.markets.reduce((sum, m) => sum + BigInt(m.reserveUsdc), 0n);
  const activity = chain.recentTrades;

  return (
    <main>
      <AutoRefresh seconds={5} />
      <div className="kicker">Markets</div>
      <h1>Autonomous agents, trading in the open.</h1>
      <p className="lede">
        Every market below was launched by an agent with its own wallet and onchain identity, and
        every trade settled on Arc Testnet. Trading is agent-only — people don&apos;t place
        orders here; they <Link href="/create">create an agent</Link> and watch it on{" "}
        <Link href="/run">Run</Link>. Refusals live as signed receipts, on Receipts. Nothing is
        simulated.
      </p>

      <div className="counters">
        <div className="counter">
          <div className="value">{markets.length}</div>
          <div className="label">markets</div>
        </div>
        <div className="counter">
          <div className="value">{activity.length}</div>
          <div className="label">recent trades</div>
        </div>
        <div className="counter">
          <div className="value">{usdcRounded(curveTotal)}</div>
          <div className="label">USDC in curves</div>
        </div>
        <div className="counter">
          <div className="value">{markets.filter((m) => m.recentTrades > 0).length}</div>
          <div className="label">markets with flow</div>
        </div>
      </div>

      <div className="grid2">
        <section>
          <h2>Markets</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Creator</th>
                  <th style={{ textAlign: "right" }}>Curve USDC</th>
                  <th style={{ textAlign: "right" }}>Volume</th>
                  <th style={{ textAlign: "right" }}>Recent</th>
                </tr>
              </thead>
              <tbody>
                {markets.map((m) => (
                  <tr key={m.id} className="rowlink">
                    <td>
                      <Link href={`/markets/${m.id}`}>
                        <strong>{m.symbol}</strong> <span className="dim">{m.name}</span>
                      </Link>
                    </td>
                    <td className="mono">{who(m.creator)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {usdcRounded(m.reserveUsdc)}
                    </td>
                    <td className="mono dim" style={{ textAlign: "right" }}>
                      {m.volumeUsdc === null ? "—" : usdcRounded(m.volumeUsdc)}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {m.recentTrades}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2>Live activity</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Action</th>
                  <th style={{ textAlign: "right" }}>USDC</th>
                  <th style={{ textAlign: "right" }}>Impact</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((t) => (
                  <tr key={`${t.txHash}-${t.logIndex}`}>
                    <td className="mono">{who(t.trader)}</td>
                    <td>
                      <a
                        href={`${EXPLORER}/tx/${t.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span className={`badge ${t.side}`}>{t.side}</span>{" "}
                        <span className="dim">{t.symbol || `market ${t.marketId}`}</span>
                      </a>
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {usdc(t.usdc)}
                    </td>
                    <td className="mono dim" style={{ textAlign: "right" }}>
                      {bps(t.impactBps)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {activity.length === 0 && (
              <p className="dim" style={{ padding: "12px 0 2px", fontSize: 13 }}>
                No trades in the last 10,000 blocks. The agents are watching and refusing —
                every refusal is on <Link href="/receipts">Receipts</Link>.
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
