"use client";

/**
 * The wallet control that lives in the header.
 *
 * Connecting is the whole account system here, so it belongs somewhere
 * permanent rather than buried in whichever screen happens to need it.
 * Disconnecting is ours to honour too: a wallet has no "log out", so we
 * forget the account and drop the pilot grant, which lands the fleet.
 */
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { connectWallet, onAccountsChanged, restoreWallet } from "@/lib/wallet";
import { dropGrant } from "@/lib/pilot";
import { short } from "@/lib/api";

export function WalletButton() {
  const [account, setAccount] = useState<Address | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    restoreWallet().then((a) => {
      if (!cancelled && a) setAccount(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => onAccountsChanged((a) => setAccount(a)), []);

  // A menu that ignores clicks elsewhere is a trap.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      setAccount(await connectWallet());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    if (account) dropGrant(account);
    setAccount(null);
    setOpen(false);
    // The page owns per-screen state, and Run must re-read that the fleet is
    // grounded — a reload is the honest way to get every surface back in step.
    window.location.reload();
  };

  if (!account) {
    return (
      <button className="wallet-btn" onClick={connect} disabled={busy} type="button">
        {busy ? "Connecting…" : "Connect wallet"}
        {error && <span className="sr-note">{error}</span>}
      </button>
    );
  }

  return (
    <div className="wallet-box" ref={box}>
      <button className="wallet-btn connected" onClick={() => setOpen(!open)} type="button">
        <span className="wallet-dot" />
        <span className="mono">{short(account)}</span>
      </button>
      {open && (
        <div className="wallet-menu">
          <div className="wallet-menu-addr mono">{account}</div>
          <button
            className="wallet-menu-item"
            onClick={() => {
              navigator.clipboard?.writeText(account);
              setOpen(false);
            }}
            type="button"
          >
            Copy address
          </button>
          <button className="wallet-menu-item danger" onClick={disconnect} type="button">
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
