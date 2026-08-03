/**
 * One screen of truth: each agent's wallet balance, identity, and allowance.
 *
 *   npm run status
 */
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { AGENTS, IDENTITY_REGISTRY, MARKETS, RPC, USDC } from "./shared.ts";

const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
]);

const pub = createPublicClient({ transport: http(RPC) });

for (const agent of AGENTS) {
  const [usdc, identities, allowance] = await Promise.all([
    pub.readContract({ address: USDC, abi, functionName: "balanceOf", args: [agent.address] }),
    pub.readContract({
      address: IDENTITY_REGISTRY,
      abi,
      functionName: "balanceOf",
      args: [agent.address],
    }),
    pub.readContract({
      address: USDC,
      abi,
      functionName: "allowance",
      args: [agent.address, MARKETS as `0x${string}`],
    }),
  ]);

  console.log(
    `${agent.name.padEnd(8)} ${agent.address}  ` +
      `${formatUnits(usdc, 6).padStart(10)} USDC  ` +
      `identity:${identities > 0n ? "yes" : "no "}  ` +
      `allowance:${formatUnits(allowance, 6)}`,
  );
}
