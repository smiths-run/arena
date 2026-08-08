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

/** Connect and make sure the wallet is on Arc Testnet (adding it if new). */
export async function connectWallet(): Promise<Address> {
  const provider = eth();
  const [addr] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
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
  return addr as Address;
}

export async function signMessage(account: Address, message: string): Promise<`0x${string}`> {
  const wallet = createWalletClient({ chain: arcTestnet, transport: custom(eth()) });
  return wallet.signMessage({ account, message });
}

/** Send whole-USDC from the owner's wallet to the agent; resolves on receipt. */
export async function sendUsdc(
  account: Address,
  to: Address,
  wholeUsdc: number,
): Promise<`0x${string}`> {
  const provider = eth();
  const wallet = createWalletClient({ chain: arcTestnet, transport: custom(provider) });
  const pub = createPublicClient({ chain: arcTestnet, transport: custom(provider) });
  const hash = await wallet.sendTransaction({
    account,
    to,
    value: parseUnits(String(wholeUsdc), 18),
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
