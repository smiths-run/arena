import { createConfig } from "ponder";
import { custom, http } from "viem";
import { MarketsAbi } from "./abis/Markets";
import { IdentityRegistryAbi } from "./abis/IdentityRegistry";

/**
 * Arc Testnet. Both public RPCs rate-limit under SDK-level usage (measured in M0), so
 * the provider-hosted endpoint is the default and PONDER_RPC_URL_5042002 overrides it.
 *
 * Arc-specific rule carried through the whole app: order by (blockNumber, logIndex),
 * never by timestamp — sub-second blocks can share one.
 */

/**
 * Every public Arc endpoint answers roughly one request a second and returns a
 * JSON-RPC error above that. Ponder 0.17 deprecated maxRequestsPerSecond
 * ("handled automatically"), and automatic is wrong here: measured on the
 * deployed indexer, 110 successful getLogs calls came with 392 errors, and each
 * error shrinks the block range, so the backfill collapsed to a crawl that
 * would have taken days.
 *
 * So the throttle is ours. One request at a time, a fixed gap between them,
 * rotating across the endpoints that can serve history — about four requests a
 * second spread over four nodes, which none of them refuse.
 */
/**
 * PONDER_RPC_URL_5042002 overrides the pool (comma-separate for several), but
 * it does not opt out of pacing: handing Ponder a bare URL is what left the
 * deployed indexer erroring on three requests in four, and an endpoint that
 * can take more than four a second loses nothing — the whole backfill is only
 * about a hundred requests either way.
 */
const ENDPOINTS = (process.env.PONDER_RPC_URL_5042002 ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

if (ENDPOINTS.length === 0) {
  ENDPOINTS.push(
    "https://rpc.testnet.arc.io",
    "https://rpc.quicknode.testnet.arc.io",
    "https://rpc.testnet.arc.network",
    "https://rpc.quicknode.testnet.arc.network",
  );
}

const GAP_MS = 250;

function pacedRotatingTransport() {
  const pool = ENDPOINTS.map((url) => http(url, { retryCount: 0, timeout: 30_000 })({}));
  let cursor = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let lastSentAt = 0;

  return custom({
    async request(body: { method: string; params?: unknown }) {
      const run = tail.then(async () => {
        const wait = lastSentAt + GAP_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastSentAt = Date.now();

        let lastErr: unknown;
        for (let i = 0; i < pool.length; i++) {
          const at = (cursor + i) % pool.length;
          try {
            const result = await pool[at].request(body as never);
            cursor = at; // stay on whatever is answering
            return result;
          } catch (err) {
            lastErr = err;
          }
        }
        throw lastErr;
      });
      // The queue must survive a failed request, or one error stalls the sync.
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  });
}
export default createConfig({
  chains: {
    arcTestnet: {
      id: 5042002,
      // Blockdaemon's Arc node is pruned and answers every historical getLogs
      // with error 4444, so it is absent from the default pool.
      rpc: pacedRotatingTransport(),
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
