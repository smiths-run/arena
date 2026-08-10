/* Independent recomputation: read the chain directly, then compare with what
   the product reports. Nothing here goes through our own aggregates. */
import { createPublicClient, http, parseAbi } from "viem";

const RPC = "https://rpc.testnet.arc.io";
const MARKETS = "0xecA93762389883C7128D5a67b8d22EC28552f352" as const;
const pub = createPublicClient({ transport: http(RPC, { retryCount: 3, timeout: 30000 }) });

const abi = parseAbi([
  "function marketCount() view returns (uint256)",
  "function markets(uint256) view returns (address token, address creator, uint256 reserveUsdc, uint256 reserveToken, uint256 creatorFees, uint64 createdAtBlock)",
  "function symbol() view returns (string)",
]);
const events = parseAbi([
  "event Bought(uint256 indexed id, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
  "event Sold(uint256 indexed id, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 impactBps, uint256 reserveUsdc, uint256 reserveToken)",
]);

const count = await pub.readContract({ address: MARKETS, abi, functionName: "marketCount" });
const head = await pub.getBlockNumber();
console.log(`chain: marketCount=${count} head=${head}`);

let reserveTotal = 0n;
const chainMarkets: any[] = [];
for (let i = 0n; i < count; i++) {
  const [token, creator, reserveUsdc] = await pub.readContract({ address: MARKETS, abi, functionName: "markets", args: [i] });
  const symbol = await pub.readContract({ address: token, abi, functionName: "symbol" });
  reserveTotal += reserveUsdc;
  chainMarkets.push({ id: i.toString(), symbol, creator, reserveUsdc });
  await new Promise(r => setTimeout(r, 250));
}

// Full log scan since deployment, 9,999-block ranges, paced.
const START = 55002424n, RANGE = 9999n;
const vol = new Map<string, bigint>(), cnt = new Map<string, number>();
let at = START, ranges = 0, failures = 0;
while (at <= head) {
  const to = at + RANGE > head ? head : at + RANGE;
  try {
    const logs = await pub.getLogs({ address: MARKETS, events, fromBlock: at, toBlock: to });
    for (const l of logs as any[]) {
      const k = l.args.id.toString();
      vol.set(k, (vol.get(k) ?? 0n) + (l.args.usdcIn ?? l.args.usdcOut ?? 0n));
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
    }
    at = to + 1n; ranges++;
  } catch { failures++; }
  await new Promise(r => setTimeout(r, 250));
}
console.log(`scanned ${ranges} ranges (${failures} retried)\n`);

let volTotal = 0n, tradeTotal = 0;
for (const m of chainMarkets) {
  m.volume = vol.get(m.id) ?? 0n; m.trades = cnt.get(m.id) ?? 0;
  volTotal += m.volume; tradeTotal += m.trades;
}
console.log("INDEPENDENT TRUTH (from chain logs):");
for (const m of chainMarkets)
  console.log(`  #${m.id.padStart(2)} ${m.symbol.padEnd(8)} reserve=${(Number(m.reserveUsdc)/1e6).toFixed(2).padStart(8)} volume=${(Number(m.volume)/1e6).toFixed(2).padStart(7)} trades=${String(m.trades).padStart(3)}`);
console.log(`  TOTALS: markets=${chainMarkets.length} reserve=${(Number(reserveTotal)/1e6).toFixed(2)} volume=${(Number(volTotal)/1e6).toFixed(2)} trades=${tradeTotal}`);

// Now what the product says.
const res = await fetch("https://agents-production-2b3a.up.railway.app/markets");
const app = await res.json() as any;
console.log("\nPRODUCT SAYS:");
let appVol = 0n, appTrades = 0, appReserve = 0n, mismatches = 0;
for (const m of app.markets) {
  appVol += BigInt(m.volumeUsdc ?? 0); appTrades += (m.tradeCount ?? 0); appReserve += BigInt(m.reserveUsdc);
  const truth = chainMarkets.find(c => c.id === m.id);
  const ok = truth && truth.symbol === m.symbol && truth.reserveUsdc === BigInt(m.reserveUsdc)
    && truth.volume === BigInt(m.volumeUsdc ?? 0) && truth.trades === (m.tradeCount ?? 0);
  if (!ok) { mismatches++;
    console.log(`  MISMATCH #${m.id}: app symbol=${m.symbol} reserve=${m.reserveUsdc} vol=${m.volumeUsdc} trades=${m.tradeCount}`);
    console.log(`            chain symbol=${truth?.symbol} reserve=${truth?.reserveUsdc} vol=${truth?.volume} trades=${truth?.trades}`);
  }
}
console.log(`  markets=${app.markets.length} reserve=${(Number(appReserve)/1e6).toFixed(2)} volume=${(Number(appVol)/1e6).toFixed(2)} trades=${appTrades}`);
console.log(`\nVERDICT: ${mismatches === 0 && app.markets.length === chainMarkets.length ? "EVERY NUMBER MATCHES THE CHAIN" : `${mismatches} MISMATCH(ES)`}`);
