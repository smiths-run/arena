"use client";

/**
 * Trade the curve from your own wallet, in the page.
 *
 * Before a wallet connects, quotes are previewed locally from indexed reserves.
 * After connecting, every read (quote, balance, allowance) goes through the
 * wallet's provider straight to the chain — the contract is authoritative —
 * and writes are the same approve-then-trade calls the agents make. The
 * contract's own ceilings (5 USDC per trade, 500 bps impact) apply to humans
 * exactly as they apply to agents.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  MARKETS,
  USDC,
  FAUCET,
  arcTestnet,
  marketsAbi,
  erc20Abi,
  previewBuy,
  previewSell,
  parseUsdc,
} from "@/lib/onchain";
import { usdc as fmtUsdc, short } from "@/lib/api";

const CHAIN_HEX = `0x${arcTestnet.id.toString(16)}`;

interface Props {
  marketId: string;
  token: string;
  symbol: string;
  reserveUsdc: string;
  reserveToken: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; txHash: string; label: string }
  | { kind: "error"; message: string };

const fmtToken = (v: bigint) =>
  (Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 });

export function TradePanel({ marketId, token, symbol, reserveUsdc, reserveToken }: Props) {
  const [account, setAccount] = useState<Address | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amountText, setAmountText] = useState("1");
  const [sellPct, setSellPct] = useState(50);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [walletUsdc, setWalletUsdc] = useState<bigint | null>(null);
  const [walletToken, setWalletToken] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<{ out: bigint; impactBps: bigint } | null>(null);
  const clients = useRef<{ pub: PublicClient; wallet: WalletClient } | null>(null);

  // Wallet detection happens after mount so the server-rendered HTML and the
  // first client render agree; the panel upgrades itself once hydrated.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const hasWallet = mounted && Boolean((window as any).ethereum);
  const id = BigInt(marketId);
  const rU = BigInt(reserveUsdc);
  const rT = BigInt(reserveToken);
  const buyIn = side === "buy" ? parseUsdc(amountText) : null;
  const sellTokens =
    side === "sell" && walletToken !== null ? (walletToken * BigInt(sellPct)) / 100n : null;

  const refreshBalances = useCallback(async (pub: PublicClient, who: Address) => {
    const [u, t] = await Promise.all([
      pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [who] }),
      pub.readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [who],
      }),
    ]);
    setWalletUsdc(u);
    setWalletToken(t);
  }, [token]);

  const connect = useCallback(async () => {
    try {
      const eth = (window as any).ethereum;
      if (!eth) return;
      setPhase({ kind: "busy", label: "connecting wallet" });
      const [addr] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      try {
        await eth.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: CHAIN_HEX }],
        });
      } catch (err: any) {
        if (err?.code !== 4902) throw err;
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: CHAIN_HEX,
              chainName: arcTestnet.name,
              nativeCurrency: arcTestnet.nativeCurrency,
              rpcUrls: arcTestnet.rpcUrls.default.http,
              blockExplorerUrls: [arcTestnet.blockExplorers.default.url],
            },
          ],
        });
      }
      const pub = createPublicClient({ chain: arcTestnet, transport: custom(eth) });
      const wallet = createWalletClient({ chain: arcTestnet, transport: custom(eth) });
      clients.current = { pub, wallet };
      setAccount(addr as Address);
      setPhase({ kind: "idle" });
      await refreshBalances(pub, addr as Address);
    } catch (err: any) {
      setPhase({ kind: "error", message: err?.shortMessage ?? err?.message ?? String(err) });
    }
  }, [refreshBalances]);

  // Quote: authoritative from the contract once connected, local preview before.
  useEffect(() => {
    const amount = side === "buy" ? buyIn : sellTokens;
    if (amount === null || amount <= 0n) {
      setQuote(null);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      const pub = clients.current?.pub;
      if (pub) {
        try {
          const fn = side === "buy" ? "quoteBuy" : "quoteSell";
          const [out, , impactBps] = (await pub.readContract({
            address: MARKETS,
            abi: marketsAbi,
            functionName: fn,
            args: [id, amount],
          })) as readonly [bigint, bigint, bigint];
          if (!stale) setQuote({ out, impactBps });
          return;
        } catch {
          /* fall through to the local preview */
        }
      }
      if (side === "buy") {
        const p = previewBuy(amount, rU, rT);
        if (!stale) setQuote({ out: p.tokensOut, impactBps: p.impactBps });
      } else {
        const p = previewSell(amount, rU, rT);
        if (!stale) setQuote({ out: p.usdcOut, impactBps: p.impactBps });
      }
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [side, buyIn, sellTokens, id, rU, rT]);

  const trade = useCallback(async () => {
    const c = clients.current;
    if (!c || !account || !quote) return;
    try {
      const spendToken = side === "buy" ? USDC : (token as Address);
      const amount = side === "buy" ? buyIn : sellTokens;
      if (amount === null || amount <= 0n) return;

      const allowance = await c.pub.readContract({
        address: spendToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, MARKETS],
      });
      if (allowance < amount) {
        setPhase({ kind: "busy", label: "approve in wallet…" });
        const approveTx = await c.wallet.writeContract({
          address: spendToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [MARKETS, amount * 100n],
          account,
          chain: arcTestnet,
        });
        setPhase({ kind: "busy", label: "waiting for approval…" });
        await c.pub.waitForTransactionReceipt({ hash: approveTx });
      }

      const minOut = (quote.out * 99n) / 100n;
      setPhase({ kind: "busy", label: `confirm ${side} in wallet…` });
      const txHash = await c.wallet.writeContract({
        address: MARKETS,
        abi: marketsAbi,
        functionName: side,
        args: [id, amount, minOut],
        account,
        chain: arcTestnet,
      });
      setPhase({ kind: "busy", label: "settling onchain…" });
      const receipt = await c.pub.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error("transaction reverted");
      setPhase({
        kind: "done",
        txHash,
        label: side === "buy" ? `bought ${symbol}` : `sold ${symbol}`,
      });
      await refreshBalances(c.pub, account);
    } catch (err: any) {
      setPhase({ kind: "error", message: err?.shortMessage ?? err?.message ?? String(err) });
    }
  }, [account, side, buyIn, sellTokens, quote, id, token, symbol, refreshBalances]);

  const busy = phase.kind === "busy";

  return (
    <section>
      <h2>Trade this market</h2>
      <div className="card trade">
        {!hasWallet ? (
          <p className="dim">
            Trading needs a browser wallet (MetaMask or Rabby). Install one, grab test USDC from{" "}
            <a href={FAUCET} target="_blank" rel="noreferrer">
              Circle&apos;s faucet
            </a>{" "}
            (pick Arc Testnet), then refresh this page. The same 5 USDC / 5% impact ceilings the
            agents live under apply to you.
          </p>
        ) : !account ? (
          <div className="trade-row">
            <p className="dim" style={{ margin: 0 }}>
              Connect a wallet to trade the curve yourself — the contract treats you exactly like
              an agent. Test USDC:{" "}
              <a href={FAUCET} target="_blank" rel="noreferrer">
                Circle faucet
              </a>{" "}
              (Arc Testnet).
            </p>
            <button className="btn primary" onClick={connect} disabled={busy}>
              Connect wallet
            </button>
          </div>
        ) : (
          <>
            <div className="trade-row dim mono" style={{ fontSize: 13 }}>
              <span>{short(account)}</span>
              <span>
                {walletUsdc !== null ? `${fmtUsdc(walletUsdc)} USDC` : "…"} ·{" "}
                {walletToken !== null ? `${fmtToken(walletToken)} ${symbol}` : "…"}
              </span>
            </div>

            <div className="trade-tabs">
              <button
                className={`btn tab ${side === "buy" ? "active" : ""}`}
                onClick={() => setSide("buy")}
                disabled={busy}
              >
                Buy
              </button>
              <button
                className={`btn tab ${side === "sell" ? "active" : ""}`}
                onClick={() => setSide("sell")}
                disabled={busy}
              >
                Sell
              </button>
            </div>

            {side === "buy" ? (
              <div className="trade-row">
                <input
                  className="trade-input mono"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  inputMode="decimal"
                  placeholder="USDC"
                  disabled={busy}
                />
                <span className="dim">USDC (max 5 per trade)</span>
              </div>
            ) : (
              <div className="trade-row">
                {[25, 50, 100].map((p) => (
                  <button
                    key={p}
                    className={`btn tab ${sellPct === p ? "active" : ""}`}
                    onClick={() => setSellPct(p)}
                    disabled={busy}
                  >
                    {p}%
                  </button>
                ))}
                <span className="dim">
                  of your {walletToken !== null ? fmtToken(walletToken) : "…"} {symbol}
                </span>
              </div>
            )}

            <div className="trade-row dim">
              {quote ? (
                side === "buy" ? (
                  <span>
                    ≈ {fmtToken(quote.out)} {symbol} · impact {(Number(quote.impactBps) / 100).toFixed(2)}%
                  </span>
                ) : (
                  <span>
                    ≈ {fmtUsdc(quote.out)} USDC · impact {(Number(quote.impactBps) / 100).toFixed(2)}%
                  </span>
                )
              ) : (
                <span>enter an amount for a quote</span>
              )}
            </div>

            <div className="trade-row">
              <button
                className="btn primary"
                onClick={trade}
                disabled={busy || !quote || quote.out <= 0n}
              >
                {busy ? (phase as { label: string }).label : side === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`}
              </button>
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <p className="trade-status ok">
            {phase.label} —{" "}
            <a
              className="mono"
              href={`${arcTestnet.blockExplorers.default.url}/tx/${phase.txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              {short(phase.txHash)}
            </a>
          </p>
        )}
        {phase.kind === "error" && <p className="trade-status err">{phase.message}</p>}
      </div>
    </section>
  );
}
