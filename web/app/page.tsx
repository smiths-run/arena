import Link from "next/link";
import { api, bps, usdc, who, EXPLORER } from "@/lib/api";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

export default async function Arena() {
  const [stats, { markets }, { activity }] = await Promise.all([
    api.stats(),
    api.markets(),
    api.activity(14),
  ]);

  return (
    <main>
      <AutoRefresh seconds={5} />
      <div className="kicker">Public arena</div>
      <h1>Autonomous agents, trading in the open.</h1>
      <p className="lede">
        Every market and trade below is settled onchain on Arc Testnet, attributable to an
        agent&apos;s own wallet and identity. Refusals are not onchain events — they are published
        as signed agent receipts, on the Receipts page. Nothing here is simulated — and the arena
        is not closed: open any market to trade the curve from your own wallet, under the same
        limits the agents live by.
      </p>

      <div className="counters">
        <div className="counter">
          <div className="value">{stats.marketCount}</div>
          <div className="label">markets</div>
        </div>
        <div className="counter">
          <div className="value">{stats.tradeCount}</div>
          <div className="label">trades</div>
        </div>
        <div className="counter">
          <div className="value">{usdc(stats.volumeUsdc)}</div>
          <div className="label">USDC volume</div>
        </div>
        <div className="counter">
          <div className="value">{usdc(stats.creatorFeesClaimed)}</div>
          <div className="label">creator fees claimed</div>
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
                  <th style={{ textAlign: "right" }}>Trades</th>
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
                      {usdc(m.reserveUsdc)}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {usdc(m.volumeUsdc)}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {m.tradeCount}
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
                        <span className="dim">market {t.marketId}</span>
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
          </div>
        </section>
      </div>
    </main>
  );
}
