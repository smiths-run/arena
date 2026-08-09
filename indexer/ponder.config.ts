import { createConfig } from "ponder";
import { MarketsAbi } from "./abis/Markets";
import { IdentityRegistryAbi } from "./abis/IdentityRegistry";

/**
 * Arc Testnet. Both public RPCs rate-limit under SDK-level usage (measured in M0), so
 * the provider-hosted endpoint is the default and PONDER_RPC_URL_5042002 overrides it.
 *
 * Arc-specific rule carried through the whole app: order by (blockNumber, logIndex),
 * never by timestamp — sub-second blocks can share one.
 */
export default createConfig({
  chains: {
    arcTestnet: {
      id: 5042002,
      // Rotating across the public endpoints is what makes the backfill finish —
      // but only across endpoints that can actually serve history. Blockdaemon's
      // Arc node is pruned and answers every historical eth_getLogs with error
      // 4444, so including it poisoned one in five requests and dragged the whole
      // sync down with it. Override with a private endpoint via
      // PONDER_RPC_URL_5042002 in production.
      rpc: process.env.PONDER_RPC_URL_5042002 ?? [
        "https://rpc.testnet.arc.io",
        "https://rpc.quicknode.testnet.arc.io",
        "https://rpc.testnet.arc.network",
        "https://rpc.quicknode.testnet.arc.network",
      ],
      // Measured on every endpoint above: 10k is accepted, 50k is refused. Left
      // to infer this from error messages, Ponder halves the range on each
      // failure and never recovers it, so a poisoned run ends up crawling a
      // sub-thousand-block window forever. Pinning the known-good range keeps
      // the whole backfill at roughly a hundred requests.
      ethGetLogsBlockRange: 10_000,
    },
  },
  contracts: {
    Markets: {
      chain: "arcTestnet",
      abi: MarketsAbi,
      address: "0xecA93762389883C7128D5a67b8d22EC28552f352",
      startBlock: 55002424,
    },
    /**
     * Arc's shared ERC-8004 registry (proxy). Indexed from the same start block, so
     * every agent registered in the Smiths Run window appears — ours and anyone
     * else's. That is the open-participation surface, not an accident.
     */
    IdentityRegistry: {
      chain: "arcTestnet",
      abi: IdentityRegistryAbi,
      address: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      startBlock: 55002424,
    },
  },
});
