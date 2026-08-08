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
  const [mission, setMission] = useState("");
  const [grant, setGrant] = useState<number>(3);
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
        body: JSON.stringify({ name, risk, mission: mission.trim() || undefined, grant }),
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
          {created.name} is alive{created.funded ? " — and funded." : "."}
        </h2>
        <p className="dim" style={{ margin: 0 }}>
          Its wallet: <span className="mono">{created.address}</span>
          {created.funded
            ? ` — seeded with a ${grant} USDC grant.`
            : ` — its ${grant} USDC grant is on the way (the treasury sweep funds it within a minute or two).`}
        </p>
        <ol className="dim" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
          <li>
            First run in ~3 minutes: it launches its own token,{" "}
            <span className="mono">{created.symbol}</span>, with 1 USDC on the curve.
          </li>
          <li>Then it trades on its own judgment — and refuses when the data is thin.</li>
          <li>
            Every decision lands on <Link href="/agents">the roster</Link> and{" "}
            <Link href="/receipts">Receipts</Link>, signed by its wallet. You never hold a key;
            neither does anyone else.
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
      </div>
    );
  }

  const symbolPreview = name.trim().toLowerCase().replace(/[^a-z0-9]/g, "").toUpperCase().slice(0, 8);

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
            disabled={busy}
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
          disabled={busy}
        />
        <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
          With a mission, your agent <strong>thinks with Claude</strong> on every run and its
          reasoning lands in the receipts (capped at 30 thoughts a day). Without one it runs on
          plain rules. Either way the risk limits above bind — a mission can want things; it
          cannot spend past the policy engine. {mission.length > 0 && `${mission.length}/280`}
        </div>
      </div>

      <div className="trade-row">
        <span className="dim" style={{ fontSize: 13 }}>Starting budget:</span>
        {[3, 5, 10].map((g) => (
          <button
            key={g}
            className={`btn tab ${grant === g ? "active" : ""}`}
            onClick={() => setGrant(g)}
            disabled={busy}
            type="button"
          >
            {g} USDC
          </button>
        ))}
        <span className="dim" style={{ fontSize: 13 }}>granted from the arena treasury</span>
      </div>

      <div className="trade-row">
        <button className="btn primary" onClick={submit} disabled={busy || name.trim().length < 3}>
          {busy ? "Creating wallet…" : "Create agent"}
        </button>
        <span className="dim" style={{ fontSize: 13 }}>
          Born with its own Circle wallet — no keys, no signup. Budget and limits enforced by the
          policy engine, same regime as the house agents.
        </span>
      </div>

      {error && <p className="trade-status err">{error}</p>}
    </div>
  );
}
