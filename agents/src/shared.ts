import "dotenv/config";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

export const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const MARKETS = required("MARKETS_ADDRESS");
export const USDC = "0x3600000000000000000000000000000000000000";
export const RPC = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.io";

/** The three testnet agents. Wallets were created in M0 and are funded. */
export const AGENTS = [
  {
    name: "anvil",
    description:
      "Autonomous trading agent on Smiths Run. Trades bonding-curve markets on Arc Testnet within a bounded USDC budget; every action and its cost are public.",
    walletId: required("AGENT_0_WALLET_ID"),
    address: required("AGENT_0_ADDRESS") as `0x${string}`,
  },
  {
    name: "bellows",
    description:
      "Autonomous analyst agent on Smiths Run. Produces market intelligence for other agents and sells it over x402 nanopayments on Arc Testnet.",
    walletId: required("AGENT_1_WALLET_ID"),
    address: required("AGENT_1_ADDRESS") as `0x${string}`,
  },
  {
    name: "tongs",
    description:
      "Autonomous market-maker agent on Smiths Run. Launches bonding-curve markets on Arc Testnet and earns creator fees from outside flow.",
    walletId: required("AGENT_2_WALLET_ID"),
    address: required("AGENT_2_ADDRESS") as `0x${string}`,
  },
] as const;

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in agents/.env`);
  return v;
}

export function circle() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: required("CIRCLE_API_KEY"),
    entitySecret: required("CIRCLE_ENTITY_SECRET"),
  });
}

/**
 * Deterministic idempotency key (UUID v4 shape) from the action's coordinates.
 * A replayed script cannot double-submit: Circle deduplicates on this.
 */
export function idempotencyKey(...parts: (string | number)[]): string {
  const hex = [...parts.join(":")]
    .reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381)
    .toString(16)
    .padStart(8, "0")
    .repeat(4)
    .slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * ERC-8004 metadata as a self-contained data: URI. No IPFS pin, no host to keep
 * alive — anyone reading the registry can resolve it forever. Production path is
 * IPFS; for a testnet identity, self-containment beats a link that can rot.
 */
export function agentURI(agent: { name: string; description: string; address: string }): string {
  const meta = {
    name: agent.name,
    description: agent.description,
    agent_type: "autonomous-trader",
    capabilities: ["launch", "trade", "publish", "x402-commerce"],
    protocol: "smiths-run",
    chainId: 5042002,
    wallet: agent.address,
    version: "0.1.0",
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(meta)).toString("base64")}`;
}

/** Submit one contract call from an agent's Circle wallet and wait for COMPLETE. */
export async function execute(
  client: ReturnType<typeof circle>,
  opts: {
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: unknown[];
    idempotency: (string | number)[];
  },
): Promise<{ txHash: string; state: string }> {
  const created = await client.createContractExecutionTransaction({
    walletId: opts.walletId,
    contractAddress: opts.contractAddress,
    abiFunctionSignature: opts.abiFunctionSignature,
    abiParameters: opts.abiParameters as never[],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: idempotencyKey(...opts.idempotency),
  });

  const done = await client.getTransaction({
    id: created.data!.id!,
    waitForState: "COMPLETE",
    pollingInterval: 500,
  });
  const tx = done.data?.transaction;
  if (tx?.state !== "COMPLETE") {
    throw new Error(`transaction ${created.data!.id} ended in ${tx?.state}: ${tx?.errorReason ?? ""}`);
  }
  return { txHash: tx.txHash!, state: tx.state };
}
