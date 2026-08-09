"use client";

/**
 * Create your agent: handle, approach, mandate, starting capital, risk.
 * Connect → sign → fund → it activates itself and begins. The handle is
 * permanent and unique on Smiths — checked live here, enforced onchain.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Address } from "viem";
import { connectWallet, sendUsdc, signMessage, balanceOf } from "@/lib/wallet";
import { short, usdc as fmtUsdc, type HandleCheck } from "@/lib/api";

const APPROACHES = [
  { id: "scout", label: "Scout", blurb: "Finds emerging markets early; wants fresh, independent participants before committing." },
  { id: "momentum", label: "Momentum", blurb: "Follows active flow; joins traction, exits what goes stale." },
  { id: "contrarian", label: "Contrarian", blurb: "Distrusts crowds and concentration; skipping a crowded market is a win." },
  { id: "builder", label: "Builder", blurb: "Develops its own market; treats creator fees as income." },
] as const;

const RISKS = [
  { id: "low", label: "Low", blurb: "0.5 USDC positions, quick profits, tight stop." },
  { id: "balanced", label: "Balanced", blurb: "1 USDC positions, 5% take-profit, 15% stop." },
  { id: "high", label: "High", blurb: "2 USDC positions, wider stop, rides winners." },
] as const;

type Created = { handle: string; symbol: string; agentWallet: string; state: string };

export function CreateAgent() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const hasWallet = mounted && Boolean((window as any).ethereum);

  const [account, setAccount] = useState<Address | null>(null);
  const [myBalance, setMyBalance] = useState<bigint | null>(null);
  const [handle, setHandle] = useState("");
  const [check, setCheck] = useState<HandleCheck | null>(null);
  const [approach, setApproach] = useState<string>("scout");
  const [risk, setRisk] = useState<string>("balanced");
  const [mandate, setMandate] = useState("");
  const [capital, setCapital] = useState("5");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [funded, setFunded] = useState(false);

  const normalized = handle.trim().toLowerCase().replace(/^@/, "");

  // Live availability, debounced; the contract has the final word at claim time.
  useEffect(() => {
    setCheck(null);
    if (normalized.length < 3) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/runs/handles/${encodeURIComponent(normalized)}`, { cache: "no-store" });
        setCheck((await res.json()) as HandleCheck);
      } catch {
        setCheck(null);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [normalized]);

  const connect = async () => {
    setError(null);
    setBusy("connecting…");
    try {
      const addr = await connectWallet();
      setAccount(addr);
      setMyBalance(await balanceOf(addr).catch(() => null));
      // One operator, one agent: if this wallet already runs one, go watch it.
      const res = await fetch(`/api/runs/agent/status?owner=${addr}`, { cache: "no-store" });
      const body = await res.json();
      if (body.exists) router.push("/run");
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
      setBusy("waiting for your signature…");
      const signature = await signMessage(account, `Smiths Run: create agent "${normalized}"`);
      setBusy("creating its wallet…");
      const res = await fetch("/api/runs/agents/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handle: normalized,
          approach,
          risk,
          mandate: mandate.trim() || undefined,
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

  const fund = async () => {
    if (!account || !created) return;
    if (!/^\d+(\.\d{1,6})?$/.test(capital.trim()) || Number(capital) <= 0) {
      setError("enter a valid amount");
      return;
    }
    setError(null);
    setBusy(`sending ${capital.trim()} USDC…`);
    try {
      await sendUsdc(account, created.agentWallet as Address, capital.trim());
      setFunded(true);
      setBusy(null);
      setTimeout(() => router.push("/run"), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  if (!hasWallet) {
    return (
      <div className="card trade">
        <p className="dim" style={{ margin: 0 }}>
          Creating an agent needs a browser wallet (MetaMask or Rabby) — it signs your agent into
          existence, owns it, and funds it with your own USDC. Install one, get test USDC from{" "}
          <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
            Circle&apos;s faucet
          </a>{" "}
          (Arc Testnet, your own address), then refresh.
        </p>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="card trade">
        <div className="trade-row">
          <p className="dim" style={{ margin: 0 }}>
            Your wallet is your identity here: one wallet, one agent, permanently named.
          </p>
          <button className="btn primary" onClick={connect} disabled={busy !== null}>
            {busy ?? "Connect wallet"}
          </button>
        </div>
        {error && <p className="trade-status err">{error}</p>}
      </div>
    );
  }

  if (created) {
    return (
      <div className="card trade">
        <h2 style={{ margin: 0 }}>
          @{created.handle} is yours{funded ? " — and funded." : "."}
        </h2>
        <p className="dim" style={{ margin: 0 }}>
          Permanent and unique on Smiths. Its wallet:{" "}
          <span className="mono">{created.agentWallet}</span>
        </p>
        {!funded ? (
          <>
            <p className="dim" style={{ margin: 0 }}>
              Give it its starting capital — from your wallet. It activates itself the moment it
              holds at least 2 USDC: registers on Arc, secures @{created.handle}, then launches{" "}
              <span className="mono">{created.symbol}</span> and starts working.
            </p>
            <div className="trade-row">
              <input
                className="trade-input"
                value={capital}
                onChange={(e) => setCapital(e.target.value)}
                inputMode="decimal"
                disabled={busy !== null}
              />
              <span className="dim">USDC</span>
              {[3, 5, 10].map((g) => (
                <button key={g} className="btn tab" onClick={() => setCapital(String(g))} disabled={busy !== null}>
                  {g}
                </button>
              ))}
              <button className="btn primary" onClick={fund} disabled={busy !== null}>
                {busy ?? `Send ${capital.trim()} USDC`}
              </button>
            </div>
          </>
        ) : (
          <p className="trade-status ok">Capital sent — taking you to Run…</p>
        )}
        {error && <p className="trade-status err">{error}</p>}
      </div>
    );
  }

  const availability =
    normalized.length < 3
      ? null
      : check === null
        ? "Checking…"
        : check.reserved
          ? "Reserved"
          : !check.valid
            ? "Invalid"
            : check.available
              ? "Available ✓"
              : "Taken";

  return (
    <div className="card trade">
      <div className="trade-row dim mono" style={{ fontSize: 13 }}>
        <span>operator: {short(account)}</span>
        {myBalance !== null && <span>{fmtUsdc(myBalance / 10n ** 12n)} USDC in your wallet</span>}
      </div>

      <div>
        <div className="field-label">HANDLE</div>
        <div className="trade-row">
          <span className="dim" style={{ fontSize: 18 }}>@</span>
          <input
            className="trade-input"
            style={{ width: 220 }}
            placeholder="test1"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            maxLength={16}
            disabled={busy !== null}
          />
          {availability && (
            <span className={availability === "Available ✓" ? "pos" : availability === "Checking…" ? "dim" : "neg"}>
              {availability}
            </span>
          )}
        </div>
        <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
          Permanent and unique on Smiths. Its token will be{" "}
          <span className="mono">
            {normalized.replace(/[^a-z0-9]/g, "").toUpperCase().slice(0, 8) || "—"}
          </span>
          .
        </div>
      </div>

      <div>
        <div className="field-label">APPROACH</div>
        <div className="risk-grid">
          {APPROACHES.map((a) => (
            <button
              key={a.id}
              className={`risk-card ${approach === a.id ? "active" : ""}`}
              onClick={() => setApproach(a.id)}
              disabled={busy !== null}
              type="button"
            >
              <div className="risk-title">{a.label}</div>
              <div className="dim" style={{ fontSize: 13 }}>{a.blurb}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="field-label">
          MANDATE <span className="dim" style={{ fontWeight: 400 }}>optional</span>
        </div>
        <textarea
          className="trade-input"
          style={{ width: "100%", minHeight: 68, resize: "vertical" }}
          placeholder="Find emerging markets. Avoid crowded entries. Take profits instead of holding forever."
          value={mandate}
          onChange={(e) => setMandate(e.target.value)}
          maxLength={280}
          disabled={busy !== null}
        />
        <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
          Your agent thinks with Claude either way; the Mandate sets its objective in your words.
          It can shape what the agent wants — never what it may spend: the risk limits below and
          the policy engine always bind. {mandate.length > 0 && `${mandate.length}/280`}
        </div>
      </div>

      <div>
        <div className="field-label">RISK</div>
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
      </div>

      <div className="trade-row">
        <button
          className="btn primary"
          onClick={create}
          disabled={busy !== null || normalized.length < 3 || (check !== null && !(check.valid && check.available))}
        >
          {busy ?? "Create agent"}
        </button>
        <span className="dim" style={{ fontSize: 13 }}>
          One free signature registers you as its operator. Starting capital comes next, from
          your wallet.
        </span>
      </div>

      {error && <p className="trade-status err">{error}</p>}
    </div>
  );
}
