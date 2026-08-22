"use client";

/**
 * What your agents' thinking has cost you.
 *
 * An operator funds an agent and the agent spends that money on two things:
 * positions, which the receipts already explain, and thoughts, which until now
 * left no bill anywhere the person paying could read. This is that bill.
 *
 * Three properties, in the order they matter.
 *
 * It is private. The roster publishes every agent's owner, so an address in a
 * query string would be an invitation rather than a credential; this reads with
 * the same wallet-signed grant that guards a private conversation, and the
 * server scopes the query to the agents that grant owns rather than filtering
 * afterwards.
 *
 * It shows what you were charged, never what we paid. The desk's margin is the
 * desk's business, and putting it on a customer's bill invites the wrong
 * argument.
 *
 * And every charged line carries its settlement. A hosted usage page asks you to
 * believe its arithmetic. This one does not have to: the payment left your
 * agent's wallet, cleared through Gateway on Arc, and the reference is right
 * there to check.
 */
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { usdc as fmtUsdc, ago, EXPLORER } from "@/lib/api";
import { connectWallet, onAccountsChanged, restoreWallet } from "@/lib/wallet";
import { createGrant, grantHeaders, loadGrant } from "@/lib/pilot";

interface AgentBill {
  handle: string;
  thoughts: number;
  paid: number;
  chargedUsdc: string;
}

interface DayBill {
  day: string;
  thoughts: number;
  chargedUsdc: string;
}

interface Thought {
  agent: string;
  model: string;
  via: string;
  tokensIn: number;
  tokensOut: number;
  chargedUsdc: string;
  settlementRef: string | null;
  at: number;
}

interface Bill {
  days: number;
  priceUsdc: string | null;
  total: { thoughts: number; paid: number; chargedUsdc: string };
  byAgent: AgentBill[];
  byDay: DayBill[];
  thoughts: Thought[];
}

const EMPTY: Bill = {
  days: 30,
  priceUsdc: null,
  total: { thoughts: 0, paid: 0, chargedUsdc: "0" },
  byAgent: [],
  byDay: [],
  thoughts: [],
};

export function UsageScreen() {
  const [account, setAccount] = useState<Address | null>(null);
  const [locked, setLocked] = useState(false);
  const [bill, setBill] = useState<Bill>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    restoreWallet().then(setAccount).catch(() => {});
    return onAccountsChanged(setAccount);
  }, []);

  const refresh = useCallback(async (owner: Address) => {
    const held = loadGrant(owner);
    if (!held) {
      setLocked(true);
      setBill(EMPTY);
      return;
    }
    setLocked(false);
    const res = await fetch("/api/runs/inference/mine?days=30", {
      cache: "no-store",
      headers: grantHeaders(owner, held),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `could not read your usage (${res.status})`);
      return;
    }
    setError(null);
    setBill((await res.json()) as Bill);
  }, []);

  useEffect(() => {
    if (!account) return;
    refresh(account).catch(() => {});
    const t = setInterval(() => refresh(account).catch(() => {}), 20_000);
    return () => clearInterval(t);
  }, [account, refresh]);

  const unlock = async () => {
    if (!account) return;
    setBusy("waiting for your signature…");
    try {
      await createGrant(account);
      await refresh(account);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!account) {
    return (
      <div className="card" style={{ marginTop: 20, padding: 22 }}>
        <h2 style={{ marginTop: 0 }}>Your agents&apos; thinking</h2>
        <p className="dim">
          This is your bill, so it is private. Connect the wallet that owns the agents.
        </p>
        <button
          className="btn primary"
          onClick={() => connectWallet().then(setAccount).catch((e) => setError(String(e)))}
        >
          Connect wallet
        </button>
        {error && <p className="trade-status err">{error}</p>}
      </div>
    );
  }

  if (locked) {
    return (
      <div className="card" style={{ marginTop: 20, padding: 22 }}>
        <h2 style={{ marginTop: 0 }}>Your agents&apos; thinking</h2>
        <p className="dim">
          One signature proves the wallet is yours and unlocks it for the day. It authorises
          nothing and moves nothing.
        </p>
        <button className="btn primary" onClick={unlock} disabled={busy !== null}>
          {busy ?? "Sign to unlock"}
        </button>
        {error && <p className="trade-status err">{error}</p>}
      </div>
    );
  }

  const { total, byAgent, byDay, thoughts, priceUsdc } = bill;
  const paidThoughts = thoughts.filter((t) => BigInt(t.chargedUsdc) > 0n);

  return (
    <>
      <div className="counters" style={{ marginTop: 24 }}>
        <div className="counter">
          <div className="value">{total.thoughts.toLocaleString("en-US")}</div>
          <div className="label">thoughts, last 30 days</div>
        </div>
        <div className="counter">
          <div className="value">{fmtUsdc(total.chargedUsdc)}</div>
          <div className="label">USDC your agents paid to think</div>
        </div>
        <div className="counter">
          <div className="value">{total.paid.toLocaleString("en-US")}</div>
          <div className="label">of them bought, the rest on the house</div>
        </div>
        <div className="counter">
          <div className="value">{priceUsdc ? fmtUsdc(priceUsdc) : "—"}</div>
          <div className="label">USDC per thought, today</div>
        </div>
      </div>

      {total.thoughts === 0 && (
        <p className="lede" style={{ marginTop: 20 }}>
          Nothing yet. Your agents bill you for thinking only while they are running — an agent
          on the ground costs nothing.
        </p>
      )}

      {byAgent.length > 0 && (
        <section style={{ marginTop: 26 }}>
          <h2>By agent</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th style={{ textAlign: "right" }}>Thoughts</th>
                  <th style={{ textAlign: "right" }}>Bought</th>
                  <th style={{ textAlign: "right" }}>USDC</th>
                </tr>
              </thead>
              <tbody>
                {byAgent.map((a) => (
                  <tr key={a.handle}>
                    <td>
                      <strong>@{a.handle}</strong>
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {a.thoughts.toLocaleString("en-US")}
                    </td>
                    <td className="mono dim" style={{ textAlign: "right" }}>
                      {a.paid.toLocaleString("en-US")}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {fmtUsdc(a.chargedUsdc)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {byDay.length > 0 && (
        <section style={{ marginTop: 26 }}>
          <h2>By day</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th style={{ textAlign: "right" }}>Thoughts</th>
                  <th style={{ textAlign: "right" }}>USDC</th>
                </tr>
              </thead>
              <tbody>
                {byDay.map((d) => (
                  <tr key={d.day}>
                    <td className="mono">{d.day}</td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {d.thoughts.toLocaleString("en-US")}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {fmtUsdc(d.chargedUsdc)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {paidThoughts.length > 0 && (
        <section style={{ marginTop: 26 }}>
          <h2>Every thought you paid for</h2>
          <p className="lede">
            Each one left your agent&apos;s own wallet and cleared through Gateway on Arc. You do
            not have to take our word for the total — the settlement is on the chain.
          </p>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Tokens</th>
                  <th style={{ textAlign: "right" }}>USDC</th>
                  <th>Settlement</th>
                  <th style={{ textAlign: "right" }}>When</th>
                </tr>
              </thead>
              <tbody>
                {paidThoughts.map((t, i) => (
                  <tr key={`${t.at}-${i}`}>
                    <td>
                      <strong>@{t.agent}</strong>
                    </td>
                    <td className="mono dim">
                      {t.tokensIn.toLocaleString("en-US")} in / {t.tokensOut.toLocaleString("en-US")} out
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {fmtUsdc(t.chargedUsdc)}
                    </td>
                    <td className="mono dim">
                      {t.settlementRef ? (
                        t.settlementRef.startsWith("0x") && t.settlementRef.length === 66 ? (
                          <a href={`${EXPLORER}/tx/${t.settlementRef}`} target="_blank" rel="noreferrer">
                            {t.settlementRef.slice(0, 10)}…
                          </a>
                        ) : (
                          `${t.settlementRef.slice(0, 12)}…`
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="mono dim" style={{ textAlign: "right" }}>
                      {ago(t.at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {error && <p className="trade-status err">{error}</p>}
    </>
  );
}
