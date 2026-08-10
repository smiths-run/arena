import Link from "next/link";
import { notFound } from "next/navigation";
import { api, bps, short, usdc, usdcRounded, who, EXPLORER } from "@/lib/api";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

/**
 * One market, read from the chain.
 *
 * This page used to ask the indexer, which meant every market except the one
 * the backfill had reached answered with a 500 — ten of eleven detail pages
 * were broken while the front page linked straight to them.
 */
export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Unreachable is not the same as nonexistent: a hiccup must not turn a real
  // market into a 404.
  const chain = await api.chain().catch(() => null);
  if (chain === null) throw new Error("chain reader unreachable");

  const market = chain.markets.find((m) => m.id === id);
  if (!market) notFound();

  const trades = chain.recentTrades.filter((t) => t.marketId === id);
  const stillReading = !chain.history.caughtUp;

  return (
    <main>
      <AutoRefresh seconds={5} />
      <div className="kicker">Market {market.id}</div>
      <h1>
        {market.symbol}{" "}
        <span className="dim" style={{ fontWeight: 400 }}>
          {market.name}
        </span>
      </h1>
      <p className="lede">
        Created by <span className="mono">{who(market.creator)}</span> · token{" "}
        <a
          className="mono"
          href={`${EXPLORER}/address/${market.token}`}
          target="_blank"
          rel="noreferrer"
        >
          {short(market.token)}
        </a>{" "}
        · <Link href="/">back to all markets</Link>
      </p>

      <div className="counters">
        <div className="counter">
          <div className="value">{usdcRounded(market.reserveUsdc)}</div>
          <div className="label">USDC in curve (incl. 125 virtual)</div>
        </div>
        <div className="counter">
          <div className="value">
            {market.volumeUsdc === null ? "—" : usdcRounded(market.volumeUsdc)}
          </div>
          <div className="label">lifetime volume</div>
        </div>
        <div className="counter">
          <div className="value">{market.tradeCount ?? "—"}</div>
          <div className="label">lifetime trades</div>
        </div>
        <div className="counter">
          <div className="value">{market.recentTrades}</div>
          <div className="label">trades in the last 10k blocks</div>
        </div>
      </div>

      {stillReading && (
        <p className="dim" style={{ fontSize: 13, marginTop: -14, marginBottom: 20 }}>
          Lifetime totals shown as “—” are still being read from the chain. Curve balance is live.
        </p>
      )}

      <section>
        <h2>Recent trades</h2>
        <div className="card">
          {trades.length === 0 ? (
            <p className="dim" style={{ margin: 0, fontSize: 13.5 }}>
              Nothing in the last 10,000 blocks. Every decision an agent made about this market,
              including the refusals, is on <Link href="/receipts">Receipts</Link>.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Side</th>
                  <th style={{ textAlign: "right" }}>USDC</th>
                  <th style={{ textAlign: "right" }}>Impact</th>
                  <th style={{ textAlign: "right" }}>Block</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={`${t.txHash}-${t.logIndex}`}>
                    <td className="mono">{who(t.trader)}</td>
                    <td>
                      <span className={`badge ${t.side}`}>{t.side}</span>
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {usdc(t.usdc)}
                    </td>
                    <td className="mono dim" style={{ textAlign: "right" }}>
                      {bps(t.impactBps)}
                    </td>
                    <td className="mono dim" style={{ textAlign: "right" }}>
                      {t.blockNumber}
                    </td>
                    <td className="mono">
                      <a href={`${EXPLORER}/tx/${t.txHash}`} target="_blank" rel="noreferrer">
                        {short(t.txHash)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}
