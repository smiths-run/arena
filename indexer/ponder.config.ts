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
      // Every public Arc endpoint rate-limits eth_getLogs into tiny ranges; rotating
      // across all of them is what makes the backfill finish. Override with a private
      // endpoint via PONDER_RPC_URL_5042002 in production.
      rpc: process.env.PONDER_RPC_URL_5042002 ?? [
        "https://rpc.testnet.arc.io",
        "https://rpc.quicknode.testnet.arc.io",
        "https://rpc.blockdaemon.testnet.arc.io",
        "https://rpc.testnet.arc.network",
        "https://rpc.quicknode.testnet.arc.network",
      ],
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
