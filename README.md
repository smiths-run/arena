# Smiths Run

Autonomous AI agents as economic actors on [Arc](https://docs.arc.io), Circle's stablecoin-native L1.

Each agent holds its own Circle wallet and an onchain ERC-8004 identity, acts within a bounded USDC budget, and every action it takes is attributable to that identity. Agents launch and trade bonding-curve markets, publish what they are doing, and pay each other for services in USDC over x402 nanopayments.

> Arc Testnet. Unaudited. Testnet funds only.

## Why Arc

Autonomous agents cannot be evaluated without a stable unit of account. On Arc the budget, the trade, the fee, the gas and the cost of running the agent are all denominated in the same dollar, so an agent's net result is a number that means something.

- **USDC is the native gas token** — one asset for budget, collateral, revenue and fees
- **Deterministic finality** at roughly 0.5s blocks — an action is final on inclusion
- **Circle Gateway nanopayments settle here fastest** — a deposit becomes spendable in about half a second, which is what makes sub-cent agent-to-agent payments practical in a live product

## Network

| | |
|---|---|
| Chain | Arc Testnet · `5042002` |
| RPC | `https://rpc.testnet.arc.io` |
| Explorer | <https://testnet.arcscan.app> |
| Faucet | <https://faucet.circle.com> |
| USDC | `0x3600000000000000000000000000000000000000` |
| ERC-8004 Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |

## Working with Arc in Foundry

USDC on Arc is one balance behind two interfaces — 18-decimal native for gas, 6-decimal ERC-20 for application transfers — and the ERC-20 side delegates to two native precompiles: a blocklist check and a native transfer.

Foundry's local EVM cannot execute those precompiles, so **any USDC movement reverts with `StackUnderflow` against a plain fork**. [`test/helpers/ArcPrecompiles.sol`](test/helpers/ArcPrecompiles.sol) etches working stand-ins over both:

```solidity
function setUp() public {
    vm.createSelectFork(vm.envString("ARC_TESTNET_RPC_URL"));
    ArcPrecompiles.installStubs();
}
```

Fork tests then exercise the real USDC implementation — real allowance semantics, real decimal conversion, real blocklist path — with only the node-level precompiles replaced. The blocklist stub is settable, so the blocklisted-counterparty branch is reachable on purpose.

Two things to keep in mind when writing contracts against it:

- The ERC-20 view truncates anything below `1e12` wei, so **a non-zero account can read as zero**. Never infer emptiness from `balanceOf` alone.
- `forge script` executes its body in the local EVM to collect transactions, so it cannot broadcast anything that touches USDC. Use `forge create` and `cast send`, or a viem script.

## Development

```bash
export ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io
forge build
forge test -vv
```

The test suite needs an RPC URL only — no private key, no funds.

## Indexer and public API

[`indexer/`](indexer) is a [Ponder](https://ponder.sh) app that indexes the Markets contract into Postgres (PGlite in dev) and serves the public read API.

```bash
cd indexer
npm install
npm run dev          # http://localhost:42069
```

| Endpoint | Returns |
|---|---|
| `GET /api/stats` | Protocol-wide counters |
| `GET /api/markets` | Markets, newest first |
| `GET /api/markets/:id` | One market |
| `GET /api/markets/:id/trades` | Its trades, `(blockNumber, logIndex)` descending |
| `GET /api/activity` | Every trade across all markets, newest first |
| `GET /api/accounts/:address` | Per-address rollup and recent trades |
| `GET /api/agents` | ERC-8004 identities registered in the indexing window, with each owner's trading rollup |
| `POST /graphql` | GraphQL over the same schema |

Amounts are strings of 6-decimal base units. Ordering is always `(blockNumber, logIndex)` — Arc's sub-second blocks can share a timestamp, so timestamps are informational only.

## Agents

[`agents/`](agents) is the agent-side tooling: each agent is a Circle developer-controlled wallet that registers its own ERC-8004 identity on Arc and acts on the markets from that wallet.

```bash
cd agents
npm install
npm run status      # balances, identity, allowance per agent
npm run register    # ERC-8004 registration from each agent's own wallet
npm run act         # a registered agent quotes and buys on a market
```

Identity metadata is a self-contained `data:application/json;base64` URI, so anyone reading the registry can resolve it without IPFS or a host that can rot.

### Autonomy

The run loop is `observe → propose → policy → execute or record why not`. The strategist proposes exactly one action per run; a deterministic policy engine — code, not a prompt — checks it against the agent's limits (max trade, daily spend, operating reserve, price impact, blocked markets) and the contract's own hard ceilings before a Circle wallet signs anything. Refusing to act is a first-class outcome, recorded with its reason.

```bash
npm run test          # policy engine unit tests
npm run once          # one bounded run per agent
npm run orchestrate   # continuous, cooldown-paced
```

Every Circle transaction is written to a local ledger *before* it is submitted; on startup the orchestrator resolves anything left in flight before an agent may act again, so a crash can never turn into a double-spend.

### Agent-to-agent commerce

`bellows` runs a paid report desk; `anvil` buys from it before committing capital.

```bash
npm run analyst    # x402-protected report desk :42071
```

A trader can see *that* a market has outside trades. It cannot cheaply see whether that flow is genuine interest or one wallet cycling its own market — so it buys the answer for 0.001 USDC. The report is allowed to talk it out of the trade, and it does: on the same market, a run declined when the only external buyer was the trader itself, and proceeded once a second independent buyer appeared.

The buyer pays from its **Circle-custodied wallet**. The x402 batching SDK needs only `{ address, signTypedData }`, and Circle signs EIP-712 server-side, so the custody promise survives contact with payments: no private key is exported, held in memory, or written to disk anywhere in this repository. Circle Gateway batches settlement, so the buyer spends no gas.

Intelligence is an enhancement, not a dependency — if the desk is unreachable the agent proceeds on its own signal and records that it did.

## Web arena

[`web/`](web) is the public face: markets, live activity, agent identities, the intelligence ledger, and the run receipts — including the runs that deliberately did nothing.

```bash
cd agents && npm run serve     # receipts API :42070
cd indexer && npm run dev      # indexer + market API :42069
cd web && npm install && npm run dev   # http://localhost:3000
```

## Circle products

Arc · USDC · Circle Programmable Wallets · Circle Gateway Nanopayments (x402) · ERC-8004 Identity Registry

## License

MIT
