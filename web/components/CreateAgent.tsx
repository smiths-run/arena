"use client";

/**
 * The visitor's one write: name + temperament in, a funded autonomous agent
 * out. The server clamps everything; this form is a thin, honest front on
 * POST /agents/create.
 */
import { useState } from "react";
import Link from "next/link";

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

type Created = { name: string; symbol: string; address: string; funded: boolean };

export function CreateAgent() {
  const [name, setName] = useState("");
  const [risk, setRisk] = useState<string>("balanced");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/runs/agents/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, risk }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `creation failed (${res.status})`);
      setCreated(body as Created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="card trade">
        <h2 style={{ margin: 0 }}>
          {created.name} is alive{created.funded ? " and funded" : ""}.
        </h2>
        <p className="dim" style={{ margin: 0 }}>
          Wallet <span className="mono">{created.address}</span>
          {created.funded
            ? " — seeded with testnet USDC from Circle's faucet."
            : " — the faucet was rate-limited; it will sit tight until funded (faucet.circle.com, Arc Testnet)."}
        </p>
        <p className="dim" style={{ margin: 0 }}>
          Within ~3 minutes it will take its first run: expect it to launch{" "}
          <span className="mono">{created.symbol}</span>, then trade on its own judgment. Every
          decision — including doing nothing — lands signed on the Receipts page.
        </p>
        <div className="trade-row">
          <Link className="btn primary" href="/receipts">
            Watch its receipts
          </Link>
          <Link className="btn" href="/agents">
            See the roster
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="card trade">
      <div className="trade-row">
        <input
          className="trade-input"
          style={{ width: 220, fontFamily: "inherit" }}
          placeholder="agent name (e.g. piston)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={16}
          disabled={busy}
        />
        <span className="dim">3–16 chars; becomes its token symbol too</span>
      </div>

      <div className="risk-grid">
        {RISKS.map((r) => (
          <button
            key={r.id}
            className={`risk-card ${risk === r.id ? "active" : ""}`}
            onClick={() => setRisk(r.id)}
            disabled={busy}
            type="button"
          >
            <div className="risk-title">{r.label}</div>
            <div className="dim" style={{ fontSize: 13 }}>{r.blurb}</div>
          </button>
        ))}
      </div>

      <div className="trade-row">
        <button className="btn primary" onClick={submit} disabled={busy || name.trim().length < 3}>
          {busy ? "Creating wallet…" : "Create agent"}
        </button>
        <span className="dim" style={{ fontSize: 13 }}>
          Its budget and limits are enforced by the policy engine — same regime as the house
          agents, hard ceilings in the contract.
        </span>
      </div>

      {error && <p className="trade-status err">{error}</p>}
    </div>
  );
}
