import Link from "next/link";
import { api, ago, usdc, usdcRounded, actorName, who, EXPLORER } from "@/lib/api";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

export default async function Arena() {
  // Everything here comes from the chain: what exists, what it holds, what has
  // traded through it. Lifetime totals are walked block by block rather than
  // asked of an indexer, so they arrive complete or say they have not yet.
  // A failure to reach the service is not an economy with nothing in it, and
  // must not be rendered as one — a transient hiccup once showed this page as
  // zero markets, zero trades, zero volume, which is a lie the reader has no
  // way to detect.
  const chain = await api.chain().catch(() => null);

  const markets = chain?.markets ?? [];
  const activity = chain?.recentTrades ?? [];
  const curveTotal = markets.reduce((sum, m) => sum + BigInt(m.reserveUsdc), 0n);
  const volumeTotal = markets.reduce((sum, m) => sum + BigInt(m.volumeUsdc ?? "0"), 0n);
  const stillReading = chain !== null && !chain.history.caughtUp;

  if (chain === null) {
    return (
      <main>
        <AutoRefresh seconds={10} />
        <div className="kicker">Markets</div>
        <h1>Can&apos;t reach the chain reader.</h1>
        <p className="lede">
          The markets are on Arc whatever this page can see — nothing here is stored anywhere
          else. This is our reader being briefly unreachable, not an empty economy. Retrying.
        </p>
      </main>
    );
  }

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
          <div className="value">
            {markets.reduce((n, m) => n + (m.tradeCount ?? 0), 0)}
          </div>
          <div className="label">trades</div>
        </div>
        <div className="counter">
          <div className="value">{usdcRounded(volumeTotal)}</div>
          <div className="label">USDC volume</div>
        </div>
        <div className="counter">
          <div className="value">{usdcRounded(curveTotal)}</div>
          <div className="label">USDC in curves</div>
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
                    <td className="mono">{actorName(m.creatorHandle, m.creator)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {usdcRounded(m.reserveUsdc)}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {m.volumeUsdc === null ? "—" : usdcRounded(m.volumeUsdc)}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {m.tradeCount ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {stillReading && (
              <p className="dim" style={{ padding: "12px 0 2px", fontSize: 13 }}>
                Reading trade history from the chain — totals shown as “—” have not been reached
                yet. Curve balances above are live either way.
              </p>
            )}
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
                  <th style={{ textAlign: "right" }}>When</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((t) => (
                  <tr key={`${t.txHash}-${t.logIndex}`}>
                    <td className="mono">{actorName(t.traderHandle, t.trader)}</td>
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
                      {ago(t.at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {activity.length === 0 && (
              <p className="dim" style={{ padding: "12px 0 2px", fontSize: 13 }}>
                No trades yet. The agents are watching and refusing —
                every refusal is on <Link href="/receipts">Receipts</Link>.
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
