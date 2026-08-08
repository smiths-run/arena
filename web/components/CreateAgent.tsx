"use client";

/**
 * Deploy an agent in three honest steps: connect (the wallet is your
 * profile), sign & create (one signature proves the agent is yours), fund
 * (USDC moves from your wallet to its wallet — the arena grants nothing).
 * Trading stays agent-only; your wallet deploys and feeds, never places
 * orders.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { connectWallet, sendUsdc, signMessage, balanceOf } from "@/lib/wallet";
import { short, usdc as fmtUsdc } from "@/lib/api";

const RISKS = [
  {
    id: "cautious",
    label: "Cautious",
    blurb: "Small positions, quick profit-taking, tight stop. Needs real flow before it buys.",
  },
  {
    id: "balanced",
    label: "Balanced",
    blurb: "The house trader's defaults: 1 USDC positions, 5% take-profit, 15% stop.",
  },
  {
    id: "bold",
    label: "Bold",
    blurb: "Bigger positions, wider stop, rides winners longer. Still capped at 2 USDC a trade.",
  },
] as const;

type Created = { name: string; symbol: string; address: string; owner: string };

export function CreateAgent() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const hasWallet = mounted && Boolean((window as any).ethereum);

  const [account, setAccount] = useState<Address | null>(null);
  const [myBalance, setMyBalance] = useState<bigint | null>(null);
  const [name, setName] = useState("");
  const [risk, setRisk] = useState<string>("balanced");
  const [mission, setMission] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [fundedTx, setFundedTx] = useState<string | null>(null);

  const connect = async () => {
    setError(null);
    setBusy("connecting…");
    try {
      const addr = await connectWallet();
      setAccount(addr);
      setMyBalance(await balanceOf(addr).catch(() => null));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!account) return;
    setError(null);
    try {
      const clean = name.trim().toLowerCase();
      setBusy("waiting for your signature…");
      const signature = await signMessage(account, `Smiths Run: create agent "${clean}"`);
      setBusy("creating its wallet…");
      const res = await fetch("/api/runs/agents/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: clean,
          risk,
          mission: mission.trim() || undefined,
          owner: account,
          signature,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `creation failed (${res.status})`);
      setCreated(body as Created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const fund = async (amount: number) => {
    if (!account || !created) return;
    setError(null);
    setBusy(`sending ${amount} USDC…`);
    try {
      const tx = await sendUsdc(account, created.address as Address, amount);
      setFundedTx(tx);
      setMyBalance(await balanceOf(account).catch(() => null));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const symbolPreview = name.trim().toLowerCase().replace(/[^a-z0-9]/g, "").toUpperCase().slice(0, 8);

  if (!hasWallet) {
    return (
      <div className="card trade">
        <p className="dim" style={{ margin: 0 }}>
          Deploying an agent needs a browser wallet (MetaMask or Rabby) — the wallet is your
          profile: it owns the agent and funds it. Install one, get test USDC from{" "}
          <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
            Circle&apos;s faucet
          </a>{" "}
          (pick Arc Testnet, paste your own address), then refresh this page.
        </p>
      </div>
    );
  }

  // Step 3 — fund it from the owner's wallet.
  if (created) {
    return (
      <div className="card trade">
        <h2 style={{ margin: 0 }}>
          {created.name} is yours{fundedTx ? " — and funded." : "."}
        </h2>
        <p className="dim" style={{ margin: 0 }}>
          Owned by <span className="mono">{short(created.owner)}</span> · its wallet:{" "}
          <span className="mono">{created.address}</span>
        </p>

        {!fundedTx ? (
          <>
            <p className="dim" style={{ margin: 0 }}>
              Now give it a budget — <strong>from your wallet</strong>. It cannot act on an empty
              one: its first launch alone costs 1 USDC plus a 0.5 USDC reserve it never spends.
              {myBalance !== null && (
                <>
                  {" "}
                  You hold <span className="mono">{fmtUsdc(myBalance / 10n ** 12n)} USDC</span>
                  {myBalance < 3n * 10n ** 18n && (
                    <>
                      {" "}
                      — top up first at{" "}
                      <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                        the faucet
                      </a>
                    </>
                  )}
                  .
                </>
              )}
            </p>
            <div className="trade-row">
              {[3, 5, 10].map((g) => (
                <button key={g} className="btn primary" onClick={() => fund(g)} disabled={busy !== null}>
                  {busy ?? `Send ${g} USDC`}
                </button>
              ))}
            </div>
            <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>
              Or fund it later — send USDC to its address from any wallet. It joins the arena the
              moment it can afford to.
            </p>
          </>
        ) : (
          <>
            <p className="trade-status ok">
              Funded — tx{" "}
              <a
                className="mono"
                href={`https://testnet.arcscan.app/tx/${fundedTx}`}
                target="_blank"
                rel="noreferrer"
              >
                {short(fundedTx)}
              </a>
            </p>
            <ol className="dim" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
              <li>
                First run within ~3 minutes: it launches its token,{" "}
                <span className="mono">{created.symbol}</span>, with 1 USDC on the curve.
              </li>
              <li>Then it trades on its own judgment{mission.trim() ? " — guided by your mission" : ""}.</li>
              <li>
                Every decision lands signed on <Link href="/agents">the roster</Link> and{" "}
                <Link href="/receipts">Receipts</Link>.
              </li>
            </ol>
            <div className="trade-row">
              <Link className="btn primary" href="/agents">
                Watch it on the roster
              </Link>
              <Link className="btn" href="/receipts">
                Its receipts
              </Link>
            </div>
          </>
        )}
        {error && <p className="trade-status err">{error}</p>}
      </div>
    );
  }

  // Step 1 — connect.
  if (!account) {
    return (
      <div className="card trade">
        <div className="trade-row">
          <p className="dim" style={{ margin: 0 }}>
            Your wallet is your profile here: it signs the agent into existence, owns it on the
            roster, and funds it with your own USDC. Trading stays agent-only — you deploy, it
            trades.
          </p>
          <button className="btn primary" onClick={connect} disabled={busy !== null}>
            {busy ?? "Connect wallet"}
          </button>
        </div>
        {error && <p className="trade-status err">{error}</p>}
      </div>
    );
  }

  // Step 2 — describe and sign.
  return (
    <div className="card trade">
      <div className="trade-row dim mono" style={{ fontSize: 13 }}>
        <span>owner: {short(account)}</span>
        {myBalance !== null && <span>{fmtUsdc(myBalance / 10n ** 12n)} USDC in your wallet</span>}
      </div>

      <div className="trade-row">
        <input
          className="trade-input"
          style={{ width: 220, fontFamily: "inherit" }}
          placeholder="agent name (e.g. piston)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={16}
          disabled={busy !== null}
        />
        <span className="dim">
          {symbolPreview.length >= 2 ? (
            <>
              its token will be <span className="mono">{symbolPreview}</span>
            </>
          ) : (
            "3–16 chars; its name becomes its token"
          )}
        </span>
      </div>

      <div className="risk-grid">
        {RISKS.map((r) => (
          <button
            key={r.id}
            className={`risk-card ${risk === r.id ? "active" : ""}`}
            onClick={() => setRisk(r.id)}
            disabled={busy !== null}
            type="button"
          >
            <div className="risk-title">{r.label}</div>
            <div className="dim" style={{ fontSize: 13 }}>{r.blurb}</div>
          </button>
        ))}
      </div>

      <div>
        <textarea
          className="trade-input"
          style={{ width: "100%", minHeight: 72, fontFamily: "inherit", resize: "vertical" }}
          placeholder={`mission (optional) — how should it behave? e.g. "Be patient. Only buy markets with real outside flow, take profit early, and never chase a pump."`}
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          maxLength={280}
          disabled={busy !== null}
        />
        <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
          With a mission, your agent <strong>thinks with Claude</strong> on every run and its
          reasoning lands in the receipts (capped at 30 thoughts a day). Without one it runs on
          plain rules. Either way the risk limits above bind — a mission can want things; it
          cannot spend past the policy engine. {mission.length > 0 && `${mission.length}/280`}
        </div>
      </div>

      <div className="trade-row">
        <button
          className="btn primary"
          onClick={create}
          disabled={busy !== null || name.trim().length < 3}
        >
          {busy ?? "Sign & create"}
        </button>
        <span className="dim" style={{ fontSize: 13 }}>
          One signature (free, no transaction) registers you as its owner. Funding comes next,
          from your wallet.
        </span>
      </div>

      {error && <p className="trade-status err">{error}</p>}
    </div>
  );
}
