import { api, bps, short, usdc, who, EXPLORER } from "@/lib/api";
import { AutoRefresh } from "@/components/AutoRefresh";
import { TradePanel } from "@/components/TradePanel";

export const dynamic = "force-dynamic";

export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [market, { trades }] = await Promise.all([api.market(id), api.marketTrades(id)]);

  return (
    <main>
      <AutoRefresh seconds={5} />
      <div className="kicker">Market {market.id}</div>
      <h1>
        {market.symbol} <span className="dim" style={{ fontWeight: 400 }}>{market.name}</span>
      </h1>
      <p className="lede">
        Created by <span className="mono">{who(market.creator)}</span> · token{" "}
        <a className="mono" href={`${EXPLORER}/address/${market.token}`} target="_blank" rel="noreferrer">
          {short(market.token)}
        </a>{" "}
        · launch{" "}
        <a className="mono" href={`${EXPLORER}/tx/${market.createdAtTx}`} target="_blank" rel="noreferrer">
          {short(market.createdAtTx)}
        </a>
      </p>

      <div className="counters">
        <div className="counter">
          <div className="value">{usdc(market.reserveUsdc)}</div>
          <div className="label">USDC in curve (incl. 125 virtual)</div>
        </div>
        <div className="counter">
          <div className="value">{usdc(market.volumeUsdc)}</div>
          <div className="label">lifetime volume</div>
        </div>
        <div className="counter">
          <div className="value">{market.tradeCount}</div>
          <div className="label">trades</div>
        </div>
        <div className="counter">
          <div className="value">{usdc(market.creatorFeesAccrued)}</div>
          <div className="label">creator fees accrued</div>
        </div>
      </div>

      <TradePanel
        marketId={market.id}
        token={market.token}
        symbol={market.symbol}
        reserveUsdc={market.reserveUsdc}
        reserveToken={market.reserveToken}
      />

      <section>
        <h2>Trades</h2>
        <div className="card">
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
        </div>
      </section>
    </main>
  );
}
