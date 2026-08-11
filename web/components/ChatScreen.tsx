"use client";

/**
 * Talking to your agent.
 *
 * The pilot grant is the session: one stored signature covers the conversation,
 * the rules you write, and the proposals that stay inside them. Anything the
 * conversation proposes still surfaces as a card with the exact wording, and
 * still executes on an explicit act — but that act is a click, because you
 * already proved who you are today.
 *
 * The wallet comes back for one thing: a proposal that crosses a rule you set.
 * Then the signature covers that exact proposal, so the override is a decision
 * you made rather than a button you happened to hit.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { connectWallet, onAccountsChanged, restoreWallet, signMessage } from "@/lib/wallet";
import { createGrant, grantHeaders, loadGrant, type PilotGrant } from "@/lib/pilot";
import type {
  AgentRule,
  AgentTrigger,
  ChatMessage,
  MyAgent,
  PendingConfirmation,
  TriggerFire,
} from "@/lib/api";
import { usdc as fmtUsdc } from "@/lib/api";

const APPROACH_OPTIONS = ["scout", "momentum", "contrarian", "builder"];
const RISK_OPTIONS = ["low", "balanced", "high"];

export function ChatScreen() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const hasWallet = mounted && Boolean((window as any).ethereum);

  const [account, setAccount] = useState<Address | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [grant, setGrant] = useState<PilotGrant | null>(null);
  const [fleet, setFleet] = useState<MyAgent[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [locked, setLocked] = useState(false);
  const [rules, setRules] = useState<AgentRule[]>([]);
  const [triggers, setTriggers] = useState<AgentTrigger[]>([]);
  const [fires, setFires] = useState<TriggerFire[]>([]);
  const [meta, setMeta] = useState<{ mandate: string | null; approach: string }>({
    mandate: null,
    approach: "scout",
  });

  const [draft, setDraft] = useState("");
  const [newRule, setNewRule] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const thread = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    restoreWallet().then((a) => {
      if (cancelled) return;
      if (a) {
        setAccount(a);
        setGrant(loadGrant(a));
      }
      setRestoring(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => onAccountsChanged((a) => setAccount(a)), []);

  /**
   * Load the fleet, and — once the wallet has proved itself — this agent's
   * private side.
   *
   * The fleet is public: it is the same information the agents directory
   * publishes. The conversation, the rules and who the agent follows are not,
   * and the server will not hand them over without the grant, so a session
   * that has not signed one is shown a lock rather than an empty page.
   */
  const refresh = useCallback(async (owner: Address, handle: string | null) => {
    const listRes = await fetch(`/api/runs/my/agents?owner=${owner}`, { cache: "no-store" });
    const list = ((await listRes.json()).agents ?? []) as MyAgent[];
    setFleet(list);
    const active = handle && list.some((a) => a.handle === handle) ? handle : (list[0]?.handle ?? null);
    setSelected(active);
    if (!active) return;

    const held = loadGrant(owner);
    if (!held) {
      setLocked(true);
      setMessages([]);
      setPending(null);
      setRules([]);
      setTriggers([]);
      setFires([]);
      return;
    }
    setLocked(false);
    const headers = grantHeaders(owner, held);
    const read = (path: string) =>
      fetch(`/api/runs/${path}?handle=${active}`, { cache: "no-store", headers }).then((x) => x.json());
    const [h, r, t] = await Promise.all([read("chat/history"), read("rules"), read("triggers")]);
    setMessages((h.messages ?? []) as ChatMessage[]);
    setPending((h.pending ?? null) as PendingConfirmation | null);
    setRules((r.rules ?? []) as AgentRule[]);
    setTriggers((t.triggers ?? []) as AgentTrigger[]);
    setFires((t.recentFires ?? []) as TriggerFire[]);
    setMeta({ mandate: r.mandate ?? null, approach: r.approach ?? "scout" });
  }, []);

  useEffect(() => {
    if (!account) return;
    refresh(account, selected).catch(() => {});
  }, [account, selected, refresh]);

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight });
  }, [messages, pending]);

  const unlock = async () => {
    if (!account) return;
    setError(null);
    setBusy("waiting for your signature…");
    try {
      await ensureGrant();
      await refresh(account, selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const ensureGrant = async (): Promise<PilotGrant> => {
    if (!account) throw new Error("no wallet");
    const existing = loadGrant(account);
    if (existing) {
      setGrant(existing);
      return existing;
    }
    const fresh = await createGrant(account);
    setGrant(fresh);
    return fresh;
  };

  const send = async () => {
    if (!account || !selected || !draft.trim()) return;
    const text = draft.trim();
    setError(null);
    setBusy("thinking…");
    setDraft("");
    setMessages((m) => [...m, { id: -1, role: "operator", content: text, created_at: Date.now() }]);
    try {
      const g = await ensureGrant();
      const res = await fetch("/api/runs/chat/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: account,
          handle: selected,
          message: text,
          expiry: g.expiry,
          signature: g.signature,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `chat failed (${res.status})`);
      setMessages((m) => [...m, { id: -2, role: "agent", content: body.reply, created_at: Date.now() }]);
      setPending((body.pending ?? null) as PendingConfirmation | null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Confirm what the agent proposed.
   *
   * Inside your own rules this is a click: the grant that let you ask for it is
   * the same authority that lets it happen. Crossing one of those rules is the
   * exception the wallet is for, and only then does a signature get asked for.
   */
  const confirm = async () => {
    if (!account || !selected || !pending) return;
    const override = pending.conflicts.length > 0;
    setError(null);
    setBusy(override ? "waiting for your signature…" : "confirming…");
    try {
      const ts = Date.now();
      const auth = override
        ? {
            ts,
            signature: await signMessage(
              account,
              `Smiths Run: confirm #${pending.id} ${pending.hash} @${selected} ${ts}`,
            ),
          }
        : await (async () => {
            const g = await ensureGrant();
            return { expiry: g.expiry, signature: g.signature };
          })();
      const res = await fetch("/api/runs/chat/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: account, handle: selected, id: pending.id, ...auth }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "confirm failed");
      setPending(null);
      await refresh(account, selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!account || !selected || !pending) return;
    setBusy("cancelling…");
    try {
      const g = await ensureGrant();
      await fetch("/api/runs/chat/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: account,
          handle: selected,
          id: pending.id,
          expiry: g.expiry,
          signature: g.signature,
        }),
      });
      setPending(null);
      await refresh(account, selected);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Panel mutations: no LLM in the path, and no wallet either.
   *
   * A rule is the operator writing down their own constraint. Charging a
   * signature for that made the list something to avoid touching, which is the
   * opposite of what a list of live constraints should be — so it rides the
   * same grant that flies the agent.
   */
  const change = async (path: string, extra: Record<string, unknown>) => {
    if (!account || !selected) return;
    setError(null);
    setBusy("saving…");
    try {
      const g = await ensureGrant();
      const res = await fetch(`/api/runs/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: account,
          handle: selected,
          expiry: g.expiry,
          signature: g.signature,
          ...extra,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed");
      await refresh(account, selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const addRule = async () => {
    const text = newRule.trim();
    if (!text) return;
    await change("rules/add", { text });
    setNewRule("");
  };

  if (!hasWallet) {
    return (
      <div className="card trade">
        <p className="dim" style={{ margin: 0 }}>
          Chat needs a browser wallet to know whose agent is speaking — install MetaMask or Rabby
          and refresh.
        </p>
      </div>
    );
  }
  if (!account && restoring) return <p className="dim">Finding your wallet…</p>;
  if (!account) {
    return (
      <div className="card trade">
        <div className="trade-row">
          <p className="dim" style={{ margin: 0 }}>
            Connect the wallet that operates your agents.
          </p>
          <button
            className="btn primary"
            onClick={() => connectWallet().then(setAccount).catch((e) => setError(String(e)))}
          >
            Connect wallet
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

  return (
    <>
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
              <span className={`fleet-state ${f.state}`}>{f.state.toUpperCase()}</span>
            </button>
          ))}
        </div>
      )}

      {locked && (
        <div className="card confirm-card">
          <div className="confirm-title">This conversation is private</div>
          <div className="confirm-summary">
            Your agents are listed publicly, and so is the wallet that owns them — so the server
            will not hand over what you and @{selected} said to each other without proof that the
            wallet is yours.
          </div>
          <div className="trade-row">
            <button className="btn primary" onClick={unlock} disabled={busy !== null}>
              {busy ?? "Unlock with your wallet"}
            </button>
            <span className="dim" style={{ fontSize: 12 }}>
              One signature, good for 24 hours — the same pilot grant that flies your agents.
            </span>
          </div>
        </div>
      )}

      <div className="chat-columns">
        <section className="chat-main">
          <div className="chat-thread card" ref={thread}>
            {locked && (
              <p className="dim" style={{ fontSize: 13.5 }}>
                Locked. Sign in above to read this conversation.
              </p>
            )}
            {!locked && messages.length === 0 && (
              <p className="dim" style={{ fontSize: 13.5 }}>
                This is a private line to @{selected}. Ask what it holds, why it acted, what it
                thinks — or tell it what to do. Anything that moves money comes back as a proposal
                you confirm; crossing a rule you set is the one thing your wallet still signs.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={`${m.id}-${i}`} className={`chat-msg ${m.role}`}>
                <div className="chat-who">{m.role === "operator" ? "you" : `@${selected}`}</div>
                <div className="chat-body">{m.content}</div>
              </div>
            ))}
            {busy === "thinking…" && <p className="dim chat-thinking">@{selected} is thinking…</p>}
          </div>

          {pending && (
            <div className="card confirm-card">
              <div className="confirm-title">
                {pending.conflicts.length > 0 ? "This crosses a rule you set" : "Ready when you are"}
              </div>
              <div className="confirm-summary">{pending.summary}</div>
              {pending.conflicts.length > 0 && (
                <div className="confirm-conflicts">
                  {pending.conflicts.map((c, i) => (
                    <div key={i} className="confirm-conflict">
                      override: <strong>{c.rule}</strong> — {c.detail}
                    </div>
                  ))}
                </div>
              )}
              <div className="trade-row">
                <button className="btn primary" onClick={confirm} disabled={busy !== null}>
                  {busy ?? (pending.conflicts.length > 0 ? "Sign & override" : "Confirm")}
                </button>
                <button className="btn" onClick={cancel} disabled={busy !== null}>
                  Cancel
                </button>
                <span className="dim" style={{ fontSize: 12 }}>
                  {pending.conflicts.length > 0
                    ? "Crossing your own rule takes a signature. Hard protocol limits still apply."
                    : "Inside your rules, so no signature. Hard protocol limits still apply."}
                </span>
              </div>
            </div>
          )}

          {error && <p className="trade-status err">{error}</p>}

          <div className="chat-composer">
            <input
              className="trade-input chat-input"
              placeholder={`Message @${selected}…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              disabled={busy !== null}
              maxLength={1000}
            />
            <button className="btn primary" onClick={send} disabled={busy !== null || !draft.trim()}>
              Send
            </button>
          </div>
          {!grant && (
            <p className="dim" style={{ fontSize: 12 }}>
              Your first message will ask for one signature — the same 24h pilot grant that flies
              your agents.
            </p>
          )}
        </section>

        <aside className="chat-side">
          <div className="card">
            <h2 style={{ marginBottom: 8 }}>Mandate</h2>
            <p className="dim" style={{ fontSize: 13, whiteSpace: "pre-wrap", margin: 0 }}>
              {meta.mandate ?? "Running on the default mandate."}
            </p>
            <p className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>
              Change it in chat: “change your mandate to …”
            </p>
          </div>

          <div className="card">
            <h2 style={{ marginBottom: 8 }}>Approach · Risk</h2>
            <div className="trade-row">
              <select
                className="trade-input"
                style={{ width: "auto" }}
                value={meta.approach}
                onChange={(e) => change("agent/set", { field: "approach", value: e.target.value })}
                disabled={busy !== null}
              >
                {APPROACH_OPTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <select
                className="trade-input"
                style={{ width: "auto" }}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    change("agent/set", { field: "risk", value: e.target.value });
                    e.target.value = "";
                  }
                }}
                disabled={busy !== null}
              >
                <option value="" disabled>
                  set risk…
                </option>
                {RISK_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <p className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>
              Changes take effect on the next run.
            </p>
          </div>

          <div className="card">
            <h2 style={{ marginBottom: 8 }}>Rules</h2>
            {rules.length === 0 && (
              <p className="dim" style={{ fontSize: 13, margin: 0 }}>
                No persistent rules yet. Rules constrain the agent further — they never loosen its
                limits.
              </p>
            )}
            <div className="rule-list">
              {rules.map((r) => (
                <div key={r.id} className={`rule-row ${r.enabled ? "" : "off"}`}>
                  <button
                    className="rule-toggle"
                    title={r.enabled ? "disable" : "enable"}
                    onClick={() => change("rules/toggle", { id: r.id, enabled: !r.enabled })}
                    disabled={busy !== null}
                    type="button"
                  >
                    {r.enabled ? "✓" : "○"}
                  </button>
                  <span className="rule-text">{r.text}</span>
                  <button
                    className="rule-delete"
                    title="remove"
                    onClick={() => change("rules/delete", { id: r.id })}
                    disabled={busy !== null}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="trade-row" style={{ marginTop: 10 }}>
              <input
                className="trade-input"
                style={{ flex: 1, width: "auto" }}
                placeholder="Never buy $DOG…"
                value={newRule}
                onChange={(e) => setNewRule(e.target.value)}
                maxLength={200}
                disabled={busy !== null}
              />
              <button className="btn" onClick={addRule} disabled={busy !== null || !newRule.trim()}>
                Add
              </button>
            </div>
          </div>

          <div className="card">
            <h2 style={{ marginBottom: 8 }}>Watching</h2>
            {triggers.length === 0 ? (
              <p className="dim" style={{ fontSize: 13, margin: 0 }}>
                Not following anyone. Ask in chat — “whenever @someone launches a coin, buy 0.5
                USDC” — and I react as it happens, while I am awake.
              </p>
            ) : (
              <div className="rule-list">
                {triggers.map((t) => (
                  <div key={t.id} className={`rule-row ${t.enabled ? "" : "off"}`}>
                    <button
                      className="rule-toggle"
                      title={t.enabled ? "disable" : "enable"}
                      onClick={() => change("triggers/toggle", { id: t.id, enabled: !t.enabled })}
                      disabled={busy !== null}
                      type="button"
                    >
                      {t.enabled ? "✓" : "○"}
                    </button>
                    <span className="rule-text">
                      <strong>@{t.target}</strong>{" "}
                      <span className="dim">
                        {t.mode === "watch"
                          ? "watched"
                          : t.mode === "mirror"
                            ? "mirrored"
                            : "evaluated"}
                      </span>
                      <span className="trigger-meta">
                        {t.mode !== "watch" && (
                          <>
                            {fmtUsdc(t.spentTodayUsdc)} / {fmtUsdc(t.dailyBudgetUsdc)} USDC today
                            {t.overrideRisk ? " · may cross your limits" : ""}
                          </>
                        )}
                        {t.lastFire && (
                          <>
                            {t.mode !== "watch" ? " · " : ""}
                            last: {t.lastFire.status.replace("_", " ")}
                          </>
                        )}
                      </span>
                    </span>
                    <button
                      className="rule-delete"
                      title="stop following"
                      onClick={() => change("triggers/delete", { id: t.id })}
                      disabled={busy !== null}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {fires.length > 0 && (
              <>
                <p className="dim" style={{ fontSize: 11.5, margin: "12px 0 6px" }}>
                  What they did about it
                </p>
                <div className="fire-list">
                  {fires.slice(0, 6).map((f) => (
                    <div key={f.id} className={`fire-row ${f.status}`}>
                      <span className="fire-status">{f.status.replace("_", " ")}</span>
                      <span className="fire-detail">{f.detail}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
