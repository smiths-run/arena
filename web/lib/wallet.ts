/**
 * The wallet is the profile: connecting proves who you are, a one-line
 * signature proves you created your agent, and funding is a plain USDC
 * transfer from your wallet to the agent's. No accounts anywhere.
 *
 * Arc quirk this file leans on: USDC is the native gas token, so "send USDC"
 * is a native-value transaction with 18 decimals — no ERC-20 call needed.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  parseUnits,
  type Address,
} from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
});

const CHAIN_HEX = `0x${arcTestnet.id.toString(16)}`;

function eth(): any {
  const e = (window as any).ethereum;
  if (!e) throw new Error("no browser wallet found");
  return e;
}

/**
 * Put the wallet on Arc Testnet, adding the chain if it has never seen it.
 * Silent restore skips the connect flow, so anything that touches the chain
 * has to ask for itself rather than assume a connect happened first.
 */
export async function ensureChain(): Promise<void> {
  const provider = eth();
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (err: any) {
    if (err?.code !== 4902) throw err;
    await provider.request({
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
}

/** Connect and make sure the wallet is on Arc Testnet (adding it if new). */
export async function connectWallet(): Promise<Address> {
  const provider = eth();
  const [addr] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  await ensureChain();
  return addr as Address;
}

/**
 * The already-granted account, if there is one — asked silently.
 *
 * A wallet remembers which sites it has authorized, so returning to Run
 * should not feel like meeting for the first time. eth_accounts never
 * prompts: it answers with the account when permission already exists, and
 * with nothing when it doesn't.
 */
export async function restoreWallet(): Promise<Address | null> {
  const provider = (window as any).ethereum;
  if (!provider) return null;
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    return (accounts?.[0] as Address) ?? null;
  } catch {
    return null;
  }
}

/** Tell me when the operator switches or disconnects an account in their wallet. */
export function onAccountsChanged(fn: (account: Address | null) => void): () => void {
  const provider = (window as any).ethereum;
  if (!provider?.on) return () => {};
  const handler = (accounts: string[]) => fn((accounts?.[0] as Address) ?? null);
  provider.on("accountsChanged", handler);
  return () => provider.removeListener?.("accountsChanged", handler);
}

export async function signMessage(account: Address, message: string): Promise<`0x${string}`> {
  const wallet = createWalletClient({ chain: arcTestnet, transport: custom(eth()) });
  return wallet.signMessage({ account, message });
}

/** Send USDC (decimal string, e.g. "2.5") from the owner's wallet; resolves on receipt. */
export async function sendUsdc(
  account: Address,
  to: Address,
  amount: string,
): Promise<`0x${string}`> {
  const provider = eth();
  await ensureChain();
  const wallet = createWalletClient({ chain: arcTestnet, transport: custom(provider) });
  const pub = createPublicClient({ chain: arcTestnet, transport: custom(provider) });
  const hash = await wallet.sendTransaction({
    account,
    to,
    value: parseUnits(amount, 18),
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("funding transaction reverted");
  return hash;
}

/** The owner's own USDC balance, for showing what they can afford. */
export async function balanceOf(account: Address): Promise<bigint> {
  const pub = createPublicClient({ chain: arcTestnet, transport: custom(eth()) });
  return pub.getBalance({ address: account });
}
