/**
 * One real market action from a registered agent's own wallet — the M3 completion
 * test: identity, wallet and market action all attributable to the same agent.
 *
 *   npm run act                     # anvil buys 1 USDC of market 0
 *   AGENT=tongs AMOUNT=1.5 npm run act
 */
import { createPublicClient, http, parseAbi } from "viem";
import { AGENTS, MARKETS, RPC, USDC, circle, execute } from "./shared.ts";

const which = process.env.AGENT ?? "anvil";
const agent = AGENTS.find((a) => a.name === which);
if (!agent) throw new Error(`unknown agent "${which}" — one of ${AGENTS.map((a) => a.name).join(", ")}`);

const marketId = BigInt(process.env.MARKET ?? "0");
const usdcIn = BigInt(Math.round(Number(process.env.AMOUNT ?? "1") * 1e6));

const marketsAbi = parseAbi([
  "function quoteBuy(uint256 id, uint256 usdcIn) view returns (uint256 tokensOut, uint256 fee, uint256 impactBps)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const usdcAbi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);

const pub = createPublicClient({ transport: http(RPC) });
const client = circle();

const [tokensOut, fee, impactBps] = await pub.readContract({
  address: MARKETS as `0x${string}`,
  abi: marketsAbi,
  functionName: "quoteBuy",
  args: [marketId, usdcIn],
});
console.log(
  `${agent.name}: quote for ${Number(usdcIn) / 1e6} USDC on market ${marketId} — ` +
    `${tokensOut} tokens, fee ${fee}, impact ${Number(impactBps) / 100}%`,
);

const allowance = await pub.readContract({
  address: USDC,
  abi: usdcAbi,
  functionName: "allowance",
  args: [agent.address, MARKETS as `0x${string}`],
});

if (allowance < usdcIn) {
  console.log(`${agent.name}: approving 100 USDC to Markets...`);
  const { txHash } = await execute(client, {
    walletId: agent.walletId,
    contractAddress: USDC,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [MARKETS, "100000000"],
    idempotency: ["m3", "approve", agent.address, MARKETS],
  });
  console.log(`${agent.name}: approved  tx=${txHash}`);
}

const { txHash } = await execute(client, {
  walletId: agent.walletId,
  contractAddress: MARKETS,
  abiFunctionSignature: "buy(uint256,uint256,uint256)",
  // minTokensOut = 99% of the quote: the curve moves if someone trades between
  // quote and execution, and the agent should not accept unbounded slippage.
  abiParameters: [marketId.toString(), usdcIn.toString(), ((tokensOut * 99n) / 100n).toString()],
  idempotency: ["m3", "buy", agent.address, marketId.toString(), usdcIn.toString(), Date.now()],
});

console.log(`${agent.name}: bought  tx=${txHash}`);
console.log(`explorer: https://testnet.arcscan.app/tx/${txHash}`);
