/**
 * Everything the browser needs to talk to Arc Testnet directly: the chain
 * definition, the two contract addresses, the ABI fragments the trade panel
 * calls, and the curve math for pre-wallet quote previews.
 *
 * The math mirrors Markets.sol exactly — fee-on-input for buys, fee-on-output
 * for sells — so the preview a visitor sees before connecting is the same
 * number the contract would quote. Once a wallet is connected the panel asks
 * the contract itself, which is authoritative.
 */
import { defineChain, parseAbi } from "viem";

export const MARKETS = "0xecA93762389883C7128D5a67b8d22EC28552f352" as const;
export const USDC = "0x3600000000000000000000000000000000000000" as const;
export const FAUCET = "https://faucet.circle.com";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
});

export const marketsAbi = parseAbi([
  "function quoteBuy(uint256 id, uint256 usdcIn) view returns (uint256 tokensOut, uint256 feeUsdc, uint256 impactBps)",
  "function quoteSell(uint256 id, uint256 tokensIn) view returns (uint256 usdcOut, uint256 feeUsdc, uint256 impactBps)",
  "function buy(uint256 id, uint256 usdcIn, uint256 minTokensOut) returns (uint256 tokensOut)",
  "function sell(uint256 id, uint256 tokensIn, uint256 minUsdcOut) returns (uint256 usdcOut)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const FEE_BPS = 100n; // 1% total fee, same constant as the contract

/** Preview of quoteBuy from indexed reserves; the contract is authoritative. */
export function previewBuy(
  usdcIn: bigint,
  reserveUsdc: bigint,
  reserveToken: bigint,
): { tokensOut: bigint; impactBps: bigint } {
  if (usdcIn <= 0n || reserveUsdc <= 0n || reserveToken <= 0n) {
    return { tokensOut: 0n, impactBps: 0n };
  }
  const fee = (usdcIn * FEE_BPS) / 10_000n;
  const netIn = usdcIn - fee;
  const tokensOut = (reserveToken * netIn) / (reserveUsdc + netIn);
  const impactBps = (netIn * 10_000n) / reserveUsdc;
  return { tokensOut, impactBps };
}

/** Preview of quoteSell from indexed reserves; the contract is authoritative. */
export function previewSell(
  tokensIn: bigint,
  reserveUsdc: bigint,
  reserveToken: bigint,
): { usdcOut: bigint; impactBps: bigint } {
  if (tokensIn <= 0n || reserveUsdc <= 0n || reserveToken <= 0n) {
    return { usdcOut: 0n, impactBps: 0n };
  }
  const gross = (reserveUsdc * tokensIn) / (reserveToken + tokensIn);
  const usdcOut = gross - (gross * FEE_BPS) / 10_000n;
  const impactBps = (tokensIn * 10_000n) / reserveToken;
  return { usdcOut, impactBps };
}

/** "1.5" USDC -> 1_500_000n base units; null for anything unusable. */
export function parseUsdc(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const v = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  return v > 0n ? v : null;
}
