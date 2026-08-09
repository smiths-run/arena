/**
 * The activation primitives: every Smiths agent — house or visitor — gets its
 * onchain identity the same way.
 *
 *   ensureIdentity(agent)        ERC-8004 registration, from the agent's own
 *                                wallet, idempotent three ways (local record,
 *                                onchain balanceOf, Circle idempotency key)
 *   ensureHandle(agent, id)      SmithsHandles claim, same discipline
 *
 * A handle becomes final only when the claim lands onchain; the contract is
 * the authority, the database is a cache of what the chain already said.
 */
import { decodeEventLog, parseAbi } from "viem";
import { IDENTITY_REGISTRY, SMITHS_HANDLES, agentURI, circle, execute } from "./shared.ts";
import { pub } from "./observe.ts";

const registryAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const handlesAbi = parseAbi([
  "function agentIdOf(string handle) view returns (uint256 agentId, bool exists)",
  "function handleOf(uint256 agentId) view returns (string)",
  "function isAvailable(string handle) view returns (bool)",
]);

export interface ActivatableAgent {
  name: string;
  walletId: string;
  address: `0x${string}`;
  description: string;
}

/** Register the agent in ERC-8004 if needed; returns its agentId either way. */
export async function ensureIdentity(
  client: ReturnType<typeof circle>,
  agent: ActivatableAgent,
  stored: { agentId: string | null },
): Promise<{ agentId: bigint; txHash: string | null }> {
  if (stored.agentId) return { agentId: BigInt(stored.agentId), txHash: null };

  const { txHash } = await execute(client, {
    walletId: agent.walletId,
    contractAddress: IDENTITY_REGISTRY,
    abiFunctionSignature: "register(string)",
    abiParameters: [agentURI(agent)],
    idempotency: ["identity", "register", agent.address],
  });

  const receipt = await pub.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== IDENTITY_REGISTRY.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "Registered") {
        return { agentId: decoded.args.agentId as bigint, txHash };
      }
    } catch {
      // other registry events — not the one we are after
    }
  }
  throw new Error(`no Registered event in ${txHash}`);
}

/** Claim the agent's handle if the chain does not already know it. */
export async function ensureHandle(
  client: ReturnType<typeof circle>,
  agent: ActivatableAgent,
  agentId: bigint,
  handle: string,
): Promise<{ txHash: string | null }> {
  const existing = await pub.readContract({
    address: SMITHS_HANDLES,
    abi: handlesAbi,
    functionName: "handleOf",
    args: [agentId],
  });
  if (existing === handle) return { txHash: null };
  if (existing !== "") {
    throw new Error(`identity ${agentId} already holds handle "${existing}"`);
  }

  const available = await pub.readContract({
    address: SMITHS_HANDLES,
    abi: handlesAbi,
    functionName: "isAvailable",
    args: [handle],
  });
  if (!available) throw new Error(`handle "${handle}" is taken or invalid onchain`);

  const { txHash } = await execute(client, {
    walletId: agent.walletId,
    contractAddress: SMITHS_HANDLES,
    abiFunctionSignature: "claim(string,uint256)",
    abiParameters: [handle, agentId.toString()],
    idempotency: ["handle", "claim", agent.address, handle],
  });
  return { txHash };
}

/** Availability as the chain sees it — the UI's answer is only a convenience. */
export async function handleAvailable(handle: string): Promise<boolean> {
  return pub.readContract({
    address: SMITHS_HANDLES,
    abi: handlesAbi,
    functionName: "isAvailable",
    args: [handle],
  });
}
