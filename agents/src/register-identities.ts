/**
 * Registers each agent in Arc's ERC-8004 IdentityRegistry — from the agent's own
 * Circle wallet, so the identity NFT is minted to the agent, not to us.
 *
 *   npm run register
 *
 * Idempotent three ways: agents/identities.json short-circuits a re-run, the
 * registry's balanceOf is checked before sending, and Circle's idempotency key
 * would refuse a duplicate submit regardless.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, decodeEventLog, http, parseAbi } from "viem";
import { AGENTS, IDENTITY_REGISTRY, RPC, agentURI, circle, execute } from "./shared.ts";

const registryAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const RECORD = new URL("../identities.json", import.meta.url).pathname;
const identities: Record<string, { agentId: string; txHash: string }> = existsSync(RECORD)
  ? JSON.parse(readFileSync(RECORD, "utf8"))
  : {};

const pub = createPublicClient({ transport: http(RPC) });
const client = circle();

for (const agent of AGENTS) {
  if (identities[agent.name]) {
    console.log(`${agent.name.padEnd(8)} already recorded  agentId=${identities[agent.name].agentId}`);
    continue;
  }

  const existing = await pub.readContract({
    address: IDENTITY_REGISTRY,
    abi: registryAbi,
    functionName: "balanceOf",
    args: [agent.address],
  });
  if (existing > 0n) {
    console.log(`${agent.name.padEnd(8)} already registered onchain (no local record — run indexer to recover id)`);
    continue;
  }

  const uri = agentURI(agent);
  console.log(`${agent.name.padEnd(8)} registering (${uri.length} byte URI)...`);

  const { txHash } = await execute(client, {
    walletId: agent.walletId,
    contractAddress: IDENTITY_REGISTRY,
    abiFunctionSignature: "register(string)",
    abiParameters: [uri],
    idempotency: ["m3", "register", agent.address],
  });

  const receipt = await pub.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
  let agentId = "?";
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== IDENTITY_REGISTRY.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "Registered") {
        agentId = decoded.args.agentId.toString();
        break;
      }
    } catch {
      // other registry events (ERC-721 Transfer etc.) — not ours to decode here
    }
  }

  identities[agent.name] = { agentId, txHash };
  writeFileSync(RECORD, JSON.stringify(identities, null, 2) + "\n");
  console.log(`${agent.name.padEnd(8)} registered  agentId=${agentId}  tx=${txHash}`);
}

console.log("done —", RECORD);
