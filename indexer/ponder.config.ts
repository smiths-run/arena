import { createConfig } from "ponder";
import { MarketsAbi } from "./abis/Markets";

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
      rpc: process.env.PONDER_RPC_URL_5042002 ?? "https://rpc.quicknode.testnet.arc.io",
    },
  },
  contracts: {
    Markets: {
      chain: "arcTestnet",
      abi: MarketsAbi,
      address: "0xecA93762389883C7128D5a67b8d22EC28552f352",
      startBlock: 55002424,
    },
  },
});
