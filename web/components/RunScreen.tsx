"use client";

/**
 * The single-agent control surface. One operator, one agent, one screen that
 * answers: what is my agent doing, what does it control, is it making or
 * losing money, what is it holding, and why did it act or refuse?
 *
 * The operator can pause, resume and add capital. They cannot trade — the
 * agent does that part.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { connectWallet, sendUsdc, signMessage } from "@/lib/wallet";
import { createGrant, dropGrant, loadGrant, tick, type PilotGrant } from "@/lib/pilot";
import { short, signedUsdc, usdc as fmtUsdc, EXPLORER, type MyAgent, type RunOverview } from "@/lib/api";

const APPROACH_LABEL: Record<string, string> = {
  scout: "Scout",
  momentum: "Momentum",
  contrarian: "Contrarian",
  builder: "Builder",
};
const RISK_LABEL: Record<string, string> = { low: "Low", balanced: "Balanced", high: "High" };
const STATE_LABEL: Record<string, string> = {
  running: "RUNNING",
  paused: "PAUSED",
  awaiting_funding: "WAITING FOR CAPITAL",
  activating: "ACTIVATING",
  error_recoverable: "NEEDS ATTENTION",
};

function pct(cost: string, value: string | null): string {
  const c = Number(cost);
  const v = value === null ? NaN : Number(value);
  if (!c || !Number.isFinite(v)) return "—";
  const p = ((v - c) / c) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

export function RunScreen() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const hasWallet = mounted && Boolean((window as any).ethereum);

  const [account, setAccount] = useState<Address | null>(null);
  const [fleet, setFleet] = useState<MyAgent[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<RunOverview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fundAmount, setFundAmount] = useState("5");
  const [showFund, setShowFund] = useState(false);

  // The pilot: this tab is the runtime. While it holds a valid grant it ticks
  // every running agent on its cooldown; close the tab and the fleet lands.
  const [grant, setGrant] = useState<PilotGrant | null>(null);
  const [pilotNote, setPilotNote] = useState<string | null>(null);
  const nextTickAt = useRef<Record<string, number>>({});
  const fleetRef = useRef<MyAgent[] | null>(null);
  fleetRef.current = fleet;

  const refresh = useCallback(
    async (owner: Address, handle: string | null) => {
      try {
        const listRes = await fetch(`/api/runs/my/agents?owner=${owner}`, { cache: "no-store" });
        const list = ((await listRes.json()).agents ?? []) as MyAgent[];
        setFleet(list);
        const active = handle && list.some((a) => a.handle === handle) ? handle : (list[0]?.handle ?? null);
        if (active !== selected) setSelected(active);
        if (active) {
          const res = await fetch(`/api/runs/run/overview?owner=${owner}&handle=${active}`, {
            cache: "no-store",
          });
          setData((await res.json()) as RunOverview);
        } else {
          setData({ exists: false });
        }
      } catch {
        /* keep the last snapshot */
      }
    },
    [selected],
  );

  useEffect(() => {
    if (!account) return;
    refresh(account, selected);
    const t = setInterval(() => refresh(account, selected), 5000);
    return () => clearInterval(t);
  }, [account, selected, refresh]);

  // Recover a stored pilot grant the moment the wallet connects.
  useEffect(() => {
    if (account) setGrant(loadGrant(account));
  }, [account]);

  // The tick loop. The server is the authority on cooldowns — a tick that
  // lands early just comes back with "cooldown" and when to try again, so
  // two tabs or a clock drift can never double-run an agent.
  useEffect(() => {
    if (!account || !grant) return;
    let stopped = false;
    const fly = async () => {
      if (stopped) return;
      const running = (fleetRef.current ?? []).filter((f) => f.state === "running");
      for (const f of running) {
        if ((nextTickAt.current[f.handle] ?? 0) > Date.now()) continue;
        try {
          const r = await tick(account, f.handle, grant);
          if (r.nextInSeconds) {
            nextTickAt.current[f.handle] = Date.now() + r.nextInSeconds * 1000;
          } else {
            nextTickAt.current[f.handle] = Date.now() + 20_000;
          }
          if (r.ran) refresh(account, selected);
        } catch {
          // A rejected grant means it lapsed — land the fleet and ask for a
          // fresh signature instead of hammering the server.
          dropGrant(account);
          setGrant(null);
          setPilotNote("Pilot grant expired — sign again to keep your agents flying.");
          return;
        }
      }
    };
    fly();
    const t = setInterval(fly, 10_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [account, grant, refresh, selected]);

  const startPilot = async () => {
    if (!account) return;
    setError(null);
    setPilotNote(null);
    setBusy("waiting for your signature…");
    try {
      setGrant(await createGrant(account));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setError(null);
    setBusy("connecting…");
    try {
      setAccount(await connectWallet());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const control = async (action: "pause" | "resume") => {
    if (!account || !data?.agent) return;
    setError(null);
    setBusy(`${action}…`);
    try {
      const ts = Date.now();
      const handle = data.agent.handle;
      const signature = await signMessage(account, `Smiths Run: ${action} @${handle} ${ts}`);
      const res = await fetch(`/api/runs/agent/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: account, handle, signature, ts }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `${action} failed`);
      await refresh(account, handle);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const fund = async () => {
    if (!account || !data?.agent) return;
    if (!/^\d+(\.\d{1,6})?$/.test(fundAmount.trim()) || Number(fundAmount) <= 0) return;
    setError(null);
    setBusy(`sending ${fundAmount} USDC…`);
    try {
      await sendUsdc(account, data.agent.wallet as Address, fundAmount.trim());
      setShowFund(false);
      await refresh(account, data.agent.handle);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!hasWallet) {
    return (
      <div className="card trade">
        <p className="dim" style={{ margin: 0 }}>
          Run is your agent&apos;s control surface. It needs a browser wallet (MetaMask or Rabby)
          to know which agent is yours — install one and refresh.
        </p>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="card trade">
        <div className="trade-row">
          <p className="dim" style={{ margin: 0 }}>
            Connect the wallet that operates your agent.
          </p>
          <button className="btn primary" onClick={connect} disabled={busy !== null}>
            {busy ?? "Connect wallet"}
          </button>
        </div>
        {error && <p className="trade-status err">{error}</p>}
      </div>
    );
  }

  if (fleet !== null && fleet.length === 0) {
    return (
      <div className="card trade">
        <p className="dim" style={{ margin: 0 }}>
          This wallet doesn&apos;t operate any agents yet.
        </p>
        <div className="trade-row">
          <Link className="btn primary" href="/create">
            Create your first agent
          </Link>
        </div>
      </div>
    );
  }

  if (!data?.agent || !data.economics) {
    return <p className="dim">Loading your agents…</p>;
  }

  const a = data.agent;
  const e = data.economics;
  const state = STATE_LABEL[a.state] ?? a.state.toUpperCase();

  return (
    <>
      <div className={`pilot-bar ${grant ? "live" : ""}`}>
        <span className={`pilot-dot ${grant ? "" : "idle"}`} />
        {grant ? (
          <div className="pilot-text">
            <div className="pilot-title">Pilot live</div>
            <div className="pilot-sub">
              Your agents run while this tab stays open — close it and they land.
            </div>
          </div>
        ) : (
          <>
            <div className="pilot-text">
              <div className="pilot-title">Fleet on the ground</div>
              <div className="pilot-sub">
                {pilotNote ??
                  "Smiths doesn't host your agents — this tab is their runtime. Start the pilot to let them fly."}
              </div>
            </div>
            <button className="btn primary" onClick={startPilot} disabled={busy !== null}>
              {busy ?? "Start pilot"}
            </button>
          </>
        )}
      </div>
      {fleet && (
        <div className="fleet-strip">
          {fleet.map((f) => (
            <button
              key={f.handle}
              className={`fleet-chip ${selected === f.handle ? "active" : ""}`}
              onClick={() => setSelected(f.handle)}
              type="button"
            >
              <span className="fleet-handle">@{f.handle}</span>
              <span className={`fleet-state ${f.state}`}>{STATE_LABEL[f.state] ?? f.state}</span>
              <span className="mono dim">{f.cashUsdc ? `${fmtUsdc(f.cashUsdc)} USDC` : "…"}</span>
            </button>
          ))}
          <Link href="/create" className="fleet-chip add">
            + New agent
          </Link>
        </div>
      )}
      <div className="run-header">
        <div>
          <h1 style={{ marginBottom: 2 }}>@{a.handle}</h1>
          <div className="dim">
            {APPROACH_LABEL[a.approach] ?? a.approach} · Risk {RISK_LABEL[a.risk] ?? a.risk}
            {a.agentId && (
              <>
                {" "}
                · <span className="mono">ERC-8004 #{a.agentId}</span>
              </>
            )}
          </div>
        </div>
        <div className="trade-row">
          <span className={`run-state ${a.state}`}>● {state}</span>
          {a.state === "running" && (
            <button className="btn" onClick={() => control("pause")} disabled={busy !== null}>
              Pause
            </button>
          )}
          {a.state === "paused" && (
            <button className="btn" onClick={() => control("resume")} disabled={busy !== null}>
              Resume
            </button>
          )}
          <button className="btn primary" onClick={() => setShowFund(!showFund)} disabled={busy !== null}>
            + Add USDC
          </button>
        </div>
      </div>

      {a.state === "awaiting_funding" && (
        <p className="trade-status err" style={{ marginTop: 8 }}>
          @{a.handle} is waiting for capital — it needs at least 2 USDC to activate.
        </p>
      )}
      {a.state === "activating" && (
        <p className="dim" style={{ marginTop: 8 }}>
          Registering @{a.handle} on Arc and securing its handle…
        </p>
      )}

      {showFund && (
        <div className="card trade" style={{ marginTop: 12 }}>
          <div className="trade-row">
            <input
              className="trade-input"
              value={fundAmount}
              onChange={(ev) => setFundAmount(ev.target.value)}
              inputMode="decimal"
              disabled={busy !== null}
            />
            <span className="dim">USDC</span>
            {[3, 5, 10].map((g) => (
              <button key={g} className="btn tab" onClick={() => setFundAmount(String(g))} disabled={busy !== null}>
                {g}
              </button>
            ))}
            <button className="btn primary" onClick={fund} disabled={busy !== null}>
              {busy ?? "Send from my wallet"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="trade-status err">{error}</p>}

      <div className="metric-strip">
        <div>
          <div className="metric-value">{e.equity ? fmtUsdc(e.equity) : "…"}</div>
          <div className="metric-label">EQUITY (USDC)</div>
        </div>
        <div>
          <div className={`metric-value ${BigInt(e.netResult) > 0n ? "pos" : BigInt(e.netResult) < 0n ? "neg" : ""}`}>
            {signedUsdc(e.netResult)}
          </div>
          <div className="metric-label">NET RESULT</div>
        </div>
        <div>
          <div className="metric-value">{e.cash ? fmtUsdc(e.cash) : "…"}</div>
          <div className="metric-label">CASH</div>
        </div>
        <div>
          <div className="metric-value">{e.positionCount}</div>
          <div className="metric-label">POSITIONS</div>
        </div>
      </div>

      <div className="run-columns">
        <section style={{ marginTop: 0 }}>
          <h2>Recent decisions</h2>
          <div className="decision-list">
            {(data.recentDecisions ?? []).length === 0 && (
              <p className="dim">
                {grant
                  ? "Nothing yet — the first run lands within moments."
                  : "Nothing yet — start the pilot above and the first run lands in seconds."}
              </p>
            )}
            {(data.recentDecisions ?? []).map((d) => (
              <div key={d.id} className="decision-row">
                <div className="decision-head">
                  <span className={`badge ${d.outcome === "acted" ? "buy" : d.outcome === "error" ? "sell" : ""}`}>
                    {(d.action ?? d.outcome ?? "run").toUpperCase()}
                  </span>
                  {d.marketId !== null && <span className="mono dim">market {d.marketId}</span>}
                  {d.usdc && <span className="mono">{fmtUsdc(d.usdc)} USDC</span>}
                  {d.netResult !== null && (
                    <span className={`mono ${BigInt(d.netResult) > 0n ? "pos" : BigInt(d.netResult) < 0n ? "neg" : "dim"}`}>
                      {signedUsdc(d.netResult)}
                    </span>
                  )}
                </div>
                <div className="dim" style={{ fontSize: 13.5 }}>{d.reason}</div>
                <div className="decision-links mono">
                  {d.signed && <span title="signed by the agent's wallet">receipt ✓</span>}
                  {d.txHash && (
                    <a href={`${EXPLORER}/tx/${d.txHash}`} target="_blank" rel="noreferrer">
                      tx {short(d.txHash)}
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="dim" style={{ fontSize: 13 }}>
            Full history on <Link href="/receipts">Receipts</Link>.
          </p>
        </section>

        <aside>
          <h2>Positions</h2>
          {(data.positions ?? []).length === 0 ? (
            <p className="dim">None yet.</p>
          ) : (
            <div className="decision-list">
              {(data.positions ?? []).map((p) => (
                <Link key={p.marketId} href={`/markets/${p.marketId}`} className="decision-row" style={{ display: "block" }}>
                  <div className="decision-head">
                    <span className="mono">market {p.marketId}</span>
                    <span className="mono">{p.valueUsdc ? `${fmtUsdc(p.valueUsdc)} USDC` : "…"}</span>
                    <span className={`mono ${pct(p.costUsdc, p.valueUsdc).startsWith("+") ? "pos" : "neg"}`}>
                      {pct(p.costUsdc, p.valueUsdc)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}

          <h2 style={{ marginTop: 24 }}>Mandate</h2>
          <p className="dim" style={{ fontSize: 13.5, whiteSpace: "pre-wrap" }}>
            {a.mandate ?? "No custom Mandate — running on the default."}
          </p>
        </aside>
      </div>
    </>
  );
}
