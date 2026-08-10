/**
 * The worker's own truth: runs, in-flight Circle transactions, positions and spend.
 * node:sqlite — zero dependencies, real durability, safe across restarts.
 *
 * The reconciliation contract lives here: a pending_tx row is written BEFORE the
 * Circle call is made, so a crash between "submitted" and "recorded" is impossible
 * to confuse with "never submitted". On startup the orchestrator resolves every
 * non-terminal row before any agent is allowed to act.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

// Overridable so tests can point the ledger at a throwaway directory instead
// of the live one.
const DIR = process.env.AGENTS_DATA_DIR ?? new URL("../data", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

export const db = new DatabaseSync(`${DIR}/agents.db`);

/**
 * Three processes share this file and all three open it at once on startup,
 * so they race to create the same tables. Without a busy timeout the loser of
 * that race gets SQLITE_BUSY immediately, dies, and takes the container with
 * it — a crash on boot that looks exactly like a broken deploy. Waiting a few
 * seconds for a lock that is held for milliseconds costs nothing.
 */
db.exec("PRAGMA busy_timeout = 10000;");

/**
 * Switching the journal mode takes an exclusive lock that a busy timeout does
 * not wait out, and on a fresh database all three processes attempt it at once.
 * Whoever gets there first sets WAL for everyone, so losing this particular
 * race is success, not failure.
 */
try {
  db.exec("PRAGMA journal_mode = WAL;");
} catch {
  /* another process is setting it right now */
}

db.exec(`

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    outcome TEXT,                -- acted | skipped | rejected | error
    action_kind TEXT,            -- buy | sell | launch | null
    reason TEXT,                 -- why skipped/rejected/errored, or action summary
    tx_hash TEXT,
    usdc TEXT,                   -- amount moved, 6-dec base units as text
    market_id TEXT
  );
  CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent, started_at);

  CREATE TABLE IF NOT EXISTS pending_tx (
    idempotency_key TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    purpose TEXT NOT NULL,
    circle_tx_id TEXT,
    state TEXT NOT NULL,         -- created | submitted | COMPLETE | FAILED | ...
    tx_hash TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS positions (
    agent TEXT NOT NULL,
    market_id TEXT NOT NULL,
    tokens TEXT NOT NULL,        -- base units as text
    cost_usdc TEXT NOT NULL,     -- what was paid for what is still held
    PRIMARY KEY (agent, market_id)
  );

  CREATE TABLE IF NOT EXISTS spends (
    agent TEXT NOT NULL,
    at INTEGER NOT NULL,         -- unix ms
    usdc TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS spends_agent ON spends(agent, at);
`);

// Additive migrations: columns that arrived after the first release.
/**
 * Add a column, tolerating the case where another process just added it.
 * Every migration here is "check, then alter", and three processes run it at
 * once on startup — so two can both see a column missing and both try to add
 * it. Losing that race is not an error; the schema ends up as intended.
 */
function addColumn(table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    if (!String(err).includes("duplicate column name")) throw err;
  }
}

const runCols = new Set(
  (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name),
);
for (const [col, type] of [
  ["intel_cost", "TEXT"],
  ["intel_verdict", "TEXT"],
  ["intel_market", "TEXT"],
  // Equity in 6-decimal USDC at the two ends of the run. The difference is the
  // run's net result with nothing left out — see equity.ts for why it is derived
  // rather than assembled from categories.
  ["equity_open", "TEXT"],
  ["equity_close", "TEXT"],
  ["equity_open_detail", "TEXT"],
  ["equity_close_detail", "TEXT"],
  ["receipt_hash", "TEXT"],
  ["receipt_signature", "TEXT"],
] as const) {
  if (!runCols.has(col)) addColumn("runs", col, type);
}

const pendingCols = new Set(
  (db.prepare("PRAGMA table_info(pending_tx)").all() as Array<{ name: string }>).map((c) => c.name),
);
for (const [col, type] of [
  // Set once the transaction's local side effects (position, spend) have been
  // written. Both the live path and the crash-recovery path check it, so effects
  // are applied exactly once no matter which of them gets there first.
  ["applied", "INTEGER NOT NULL DEFAULT 0"],
  // The action this transaction represents, independent of which attempt it was.
  ["logical_key", "TEXT"],
  ["agent_name", "TEXT"],
  ["run_id", "INTEGER"],
] as const) {
  if (!pendingCols.has(col)) addColumn("pending_tx", col, type);
}

if (!pendingCols.has("applied")) {
  // Rows that were already terminal when this column arrived had their effects
  // written by the previous code path. Leaving them at the default of 0 would
  // make the first reconciliation replay every historical transaction and double
  // every position, so they are backfilled as applied.
  db.exec("UPDATE pending_tx SET applied = 1 WHERE state = 'COMPLETE'");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS intel_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER,
    buyer TEXT NOT NULL,
    market_id TEXT NOT NULL,
    cost_usdc TEXT NOT NULL,
    verdict TEXT,
    settlement_ref TEXT,
    at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS intel_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller TEXT NOT NULL,
    payer TEXT NOT NULL,
    market_id TEXT NOT NULL,
    amount_usdc TEXT NOT NULL,
    settlement_ref TEXT,
    at INTEGER NOT NULL
  );

  -- Operator control (Mission Control writes, the orchestrator reads). These sit
  -- in the shared ledger rather than in signals or files so a pause survives a
  -- restart and a run request is consumed exactly once.
  CREATE TABLE IF NOT EXISTS control (
    agent TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS run_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    at INTEGER NOT NULL
  );

  -- Visitor-created agents. The row is the agent: its Circle wallet, its
  -- strategy (JSON, bigints as strings), and whether the orchestrator should
  -- wake it. Static agents live in config; these live here.
  CREATE TABLE IF NOT EXISTS user_agents (
    name TEXT PRIMARY KEY,
    wallet_id TEXT NOT NULL,
    address TEXT NOT NULL,
    strategy TEXT NOT NULL,
    creator_ip TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  -- One-value settings (e.g. the visitor wallet set id, created once).
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Additive migration: whether a visitor agent has received its treasury
// grant. Rows that predate the column are 0, which makes the funding sweep
// look at them — exactly right for agents created before the treasury existed.
{
  const cols = new Set(
    (db.prepare("PRAGMA table_info(user_agents)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  if (!cols.has("granted")) {
    addColumn("user_agents", "granted", "INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.has("mission")) {
    addColumn("user_agents", "mission", "TEXT");
  }
  if (!cols.has("grant_usdc")) {
    addColumn("user_agents", "grant_usdc", "TEXT NOT NULL DEFAULT '3000000'");
  }
  if (!cols.has("owner")) {
    addColumn("user_agents", "owner", "TEXT");
  }
  // Primitive v1: onchain identity, behavioral approach, and a creation state
  // machine. Rows that predate these read as active scouts with no identity
  // yet — the activation sweep notices the missing agent_id and repairs them.
  if (!cols.has("approach")) {
    addColumn("user_agents", "approach", "TEXT NOT NULL DEFAULT 'scout'");
  }
  if (!cols.has("state")) {
    addColumn("user_agents", "state", "TEXT NOT NULL DEFAULT 'active'");
  }
  if (!cols.has("agent_id")) {
    addColumn("user_agents", "agent_id", "TEXT");
  }
  if (!cols.has("identity_tx")) {
    addColumn("user_agents", "identity_tx", "TEXT");
  }
  if (!cols.has("handle_tx")) {
    addColumn("user_agents", "handle_tx", "TEXT");
  }
}

db.exec(`

  -- Inference is a cost, so it gets a ledger like every other cost: one row
  -- per LLM call, and the daily cap is counted from here.
  CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS llm_calls_agent ON llm_calls(agent, at);
`);

// ── runs ────────────────────────────────────────────────────────────────────

export function recordReceipt(runId: number, hash: string, signature: string): void {
  db.prepare("UPDATE runs SET receipt_hash = ?, receipt_signature = ? WHERE id = ?").run(
    hash,
    signature,
    runId,
  );
}

export function runById(runId: number): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as never;
}

export function recordEquity(
  runId: number,
  which: "open" | "close",
  total: bigint,
  detail: unknown,
): void {
  const col = which === "open" ? "equity_open" : "equity_close";
  const detailCol = which === "open" ? "equity_open_detail" : "equity_close_detail";
  db.prepare(`UPDATE runs SET ${col} = ?, ${detailCol} = ? WHERE id = ?`).run(
    total.toString(),
    JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    runId,
  );
}

/** Lifetime net result per agent: the sum of every completed run's equity delta. */
export function netResultByAgent(): Array<{ agent: string; runs: number; net: string }> {
  const rows = db
    .prepare(
      `SELECT agent, COUNT(*) runs,
              SUM(CAST(equity_close AS INTEGER) - CAST(equity_open AS INTEGER)) net
       FROM runs
       WHERE equity_open IS NOT NULL AND equity_close IS NOT NULL
       GROUP BY agent`,
    )
    .all() as Array<{ agent: string; runs: number; net: number | null }>;
  return rows.map((r) => ({ agent: r.agent, runs: r.runs, net: String(r.net ?? 0) }));
}

export function startRun(agent: string, trigger: string): number {
  const r = db
    .prepare("INSERT INTO runs (agent, trigger_kind, started_at) VALUES (?, ?, ?)")
    .run(agent, trigger, Date.now());
  return Number(r.lastInsertRowid);
}

export function finishRun(
  id: number,
  outcome: "acted" | "skipped" | "rejected" | "error",
  fields: {
    actionKind?: string;
    reason?: string;
    txHash?: string;
    usdc?: bigint;
    marketId?: bigint;
    intelCost?: bigint;
    intelVerdict?: string;
    intelMarket?: bigint;
  },
): void {
  db.prepare(
    `UPDATE runs SET finished_at = ?, outcome = ?, action_kind = ?, reason = ?, tx_hash = ?, usdc = ?, market_id = ?,
       intel_cost = ?, intel_verdict = ?, intel_market = ?
     WHERE id = ?`,
  ).run(
    Date.now(),
    outcome,
    fields.actionKind ?? null,
    fields.reason ?? null,
    fields.txHash ?? null,
    fields.usdc?.toString() ?? null,
    fields.marketId?.toString() ?? null,
    fields.intelCost?.toString() ?? null,
    fields.intelVerdict ?? null,
    fields.intelMarket?.toString() ?? null,
    id,
  );
}

export function intelPurchaseRecord(fields: {
  runId: number | null;
  buyer: string;
  marketId: bigint;
  costUsdc: bigint;
  verdict: string | null;
  settlementRef: string | null;
}): void {
  db.prepare(
    `INSERT INTO intel_purchases (run_id, buyer, market_id, cost_usdc, verdict, settlement_ref, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.runId,
    fields.buyer,
    fields.marketId.toString(),
    fields.costUsdc.toString(),
    fields.verdict,
    fields.settlementRef,
    Date.now(),
  );
}

export function intelSaleRecord(fields: {
  seller: string;
  payer: string;
  marketId: string;
  amountUsdc: bigint;
  settlementRef: string | null;
}): void {
  db.prepare(
    `INSERT INTO intel_sales (seller, payer, market_id, amount_usdc, settlement_ref, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.seller,
    fields.payer,
    fields.marketId,
    fields.amountUsdc.toString(),
    fields.settlementRef,
    Date.now(),
  );
}

export function intelTotals(): {
  bought: Array<{ buyer: string; count: number; total: string }>;
  sold: Array<{ seller: string; count: number; total: string }>;
} {
  const bought = db
    .prepare(
      "SELECT buyer, COUNT(*) count, SUM(CAST(cost_usdc AS INTEGER)) total FROM intel_purchases GROUP BY buyer",
    )
    .all() as never;
  const sold = db
    .prepare(
      "SELECT seller, COUNT(*) count, SUM(CAST(amount_usdc AS INTEGER)) total FROM intel_sales GROUP BY seller",
    )
    .all() as never;
  return { bought, sold };
}

export function recentRuns(limit = 20): unknown[] {
  return db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit);
}

export function recentRunsFor(
  agent: string,
  limit = 10,
): Array<{
  outcome: string | null;
  action_kind: string | null;
  market_id: string | null;
  usdc: string | null;
  reason: string | null;
}> {
  return db
    .prepare(
      "SELECT outcome, action_kind, market_id, usdc, reason FROM runs WHERE agent = ? ORDER BY id DESC LIMIT ?",
    )
    .all(agent, limit) as never;
}

export function lastRunAt(agent: string): number {
  const row = db
    .prepare("SELECT MAX(started_at) AS at FROM runs WHERE agent = ?")
    .get(agent) as { at: number | null };
  return row.at ?? 0;
}

// ── pending transactions (reconciliation) ──────────────────────────────────

export function pendingCreate(
  key: string,
  agent: string,
  purpose: string,
  logicalKey: string,
  runId: number | null,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO pending_tx (idempotency_key, agent, purpose, state, updated_at, logical_key, run_id)
     VALUES (?, ?, ?, 'created', ?, ?, ?)`,
  ).run(key, agent, purpose, Date.now(), logicalKey, runId);
}

/**
 * How many times this exact action has already ended in a terminal failure.
 *
 * Retries need a fresh idempotency key — Circle replays the original outcome for
 * a repeated key, so a failed attempt would stay failed forever. Deriving the
 * attempt number from the ledger rather than the clock keeps the key
 * deterministic: the same action after the same history always produces the same
 * key, which is what makes a replayed run safe.
 */
export function failedAttempts(logicalKey: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) n FROM pending_tx
       WHERE logical_key = ? AND state IN ('FAILED','DENIED','CANCELLED')`,
    )
    .get(logicalKey) as { n: number };
  return row.n;
}

/**
 * Launches this agent has submitted that have not reached a terminal state.
 *
 * A cap has to count what is in flight as well as what is confirmed. Reading only
 * the chain closes the indexer-lag window but leaves the mempool window open: a
 * launch submitted two seconds ago is on neither the chain nor the indexer, and
 * without this the agent would launch again.
 */
export function inFlightLaunches(agent: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) n FROM pending_tx
       WHERE agent = ? AND purpose = 'launch'
         AND state NOT IN ('FAILED','DENIED','CANCELLED')
         AND applied = 0`,
    )
    .get(agent) as { n: number };
  return row.n;
}

export function isApplied(key: string): boolean {
  const row = db
    .prepare("SELECT applied FROM pending_tx WHERE idempotency_key = ?")
    .get(key) as { applied: number } | undefined;
  return row?.applied === 1;
}

export function markApplied(key: string): void {
  db.prepare("UPDATE pending_tx SET applied = 1 WHERE idempotency_key = ?").run(key);
}

/** Completed transactions whose local side effects were never written. */
export function completedButUnapplied(): Array<{
  idempotency_key: string;
  agent: string;
  purpose: string;
  tx_hash: string | null;
}> {
  return db
    .prepare(
      `SELECT idempotency_key, agent, purpose, tx_hash FROM pending_tx
       WHERE state = 'COMPLETE' AND applied = 0 AND tx_hash IS NOT NULL`,
    )
    .all() as never;
}

export function pendingSubmitted(key: string, circleTxId: string): void {
  db.prepare(
    "UPDATE pending_tx SET circle_tx_id = ?, state = 'submitted', updated_at = ? WHERE idempotency_key = ?",
  ).run(circleTxId, Date.now(), key);
}

export function pendingTerminal(key: string, state: string, txHash: string | null): void {
  db.prepare(
    "UPDATE pending_tx SET state = ?, tx_hash = ?, updated_at = ? WHERE idempotency_key = ?",
  ).run(state, txHash, Date.now(), key);
}

export function unresolvedPending(): Array<{
  idempotency_key: string;
  agent: string;
  purpose: string;
  circle_tx_id: string | null;
  state: string;
}> {
  return db
    .prepare(
      "SELECT idempotency_key, agent, purpose, circle_tx_id, state FROM pending_tx WHERE state NOT IN ('COMPLETE','FAILED','DENIED','CANCELLED')",
    )
    .all() as never;
}

// ── positions & spend ──────────────────────────────────────────────────────

export function positionAdd(agent: string, marketId: bigint, tokens: bigint, costUsdc: bigint): void {
  db.prepare(
    `INSERT INTO positions (agent, market_id, tokens, cost_usdc) VALUES (?, ?, ?, ?)
     ON CONFLICT(agent, market_id) DO UPDATE SET
       tokens = CAST(CAST(tokens AS INTEGER) + CAST(excluded.tokens AS INTEGER) AS TEXT),
       cost_usdc = CAST(CAST(cost_usdc AS INTEGER) + CAST(excluded.cost_usdc AS INTEGER) AS TEXT)`,
  ).run(agent, marketId.toString(), tokens.toString(), costUsdc.toString());
}

export function positionReduce(agent: string, marketId: bigint, tokensSold: bigint): void {
  const row = getPosition(agent, marketId);
  if (!row) return;
  const remaining = row.tokens - tokensSold;
  if (remaining <= 0n) {
    db.prepare("DELETE FROM positions WHERE agent = ? AND market_id = ?").run(
      agent,
      marketId.toString(),
    );
    return;
  }
  // Cost basis leaves proportionally with the tokens.
  const remainingCost = (row.costUsdc * remaining) / row.tokens;
  db.prepare("UPDATE positions SET tokens = ?, cost_usdc = ? WHERE agent = ? AND market_id = ?").run(
    remaining.toString(),
    remainingCost.toString(),
    agent,
    marketId.toString(),
  );
}

export function getPosition(
  agent: string,
  marketId: bigint,
): { tokens: bigint; costUsdc: bigint } | null {
  const row = db
    .prepare("SELECT tokens, cost_usdc FROM positions WHERE agent = ? AND market_id = ?")
    .get(agent, marketId.toString()) as { tokens: string; cost_usdc: string } | undefined;
  return row ? { tokens: BigInt(row.tokens), costUsdc: BigInt(row.cost_usdc) } : null;
}

export function positionsOf(agent: string): Array<{ marketId: bigint; tokens: bigint; costUsdc: bigint }> {
  const rows = db
    .prepare("SELECT market_id, tokens, cost_usdc FROM positions WHERE agent = ?")
    .all(agent) as Array<{ market_id: string; tokens: string; cost_usdc: string }>;
  return rows.map((r) => ({
    marketId: BigInt(r.market_id),
    tokens: BigInt(r.tokens),
    costUsdc: BigInt(r.cost_usdc),
  }));
}

export function spendRecord(agent: string, usdc: bigint): void {
  db.prepare("INSERT INTO spends (agent, at, usdc) VALUES (?, ?, ?)").run(
    agent,
    Date.now(),
    usdc.toString(),
  );
}

export function spentLast24h(agent: string): bigint {
  const rows = db
    .prepare("SELECT usdc FROM spends WHERE agent = ? AND at > ?")
    .all(agent, Date.now() - 24 * 3600 * 1000) as Array<{ usdc: string }>;
  return rows.reduce((sum, r) => sum + BigInt(r.usdc), 0n);
}

// ── operator control ────────────────────────────────────────────────────────

export function setPaused(agent: string, paused: boolean): void {
  db.prepare(
    `INSERT INTO control (agent, paused, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agent) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at`,
  ).run(agent, paused ? 1 : 0, Date.now());
}

export function isPaused(agent: string): boolean {
  const row = db.prepare("SELECT paused FROM control WHERE agent = ?").get(agent) as
    | { paused: number }
    | undefined;
  return row?.paused === 1;
}

export function requestRun(agent: string): void {
  db.prepare("INSERT INTO run_requests (agent, requested_at) VALUES (?, ?)").run(agent, Date.now());
}

/**
 * Consume one pending run request for this agent, if any. Consuming rather than
 * reading is what makes "run now" mean once: two clicks are two rows, and each
 * row triggers exactly one run.
 */
export function takeRunRequest(agent: string): boolean {
  const row = db
    .prepare(
      "SELECT id FROM run_requests WHERE agent = ? AND consumed_at IS NULL ORDER BY id LIMIT 1",
    )
    .get(agent) as { id: number } | undefined;
  if (!row) return false;
  db.prepare("UPDATE run_requests SET consumed_at = ? WHERE id = ?").run(Date.now(), row.id);
  return true;
}

export function hasPendingRunRequest(agent: string): boolean {
  const row = db
    .prepare("SELECT id FROM run_requests WHERE agent = ? AND consumed_at IS NULL LIMIT 1")
    .get(agent) as { id: number } | undefined;
  return row !== undefined;
}

// ── visitor agents ──────────────────────────────────────────────────────────

export interface UserAgentRow {
  name: string;
  wallet_id: string;
  address: string;
  strategy: string;
  mission: string | null;
  grant_usdc: string;
  owner: string | null;
  approach: string;
  state: string;
  agent_id: string | null;
  identity_tx: string | null;
  handle_tx: string | null;
  active: number;
  created_at: number;
}

export function userAgentCreate(row: {
  name: string;
  walletId: string;
  address: string;
  strategyJson: string;
  mission: string | null;
  owner: string;
  approach: string;
  state: string;
  creatorIp: string | null;
}): void {
  db.prepare(
    `INSERT INTO user_agents (name, wallet_id, address, strategy, mission, owner, approach, state, creator_ip, granted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    row.name,
    row.walletId,
    row.address,
    row.strategyJson,
    row.mission,
    row.owner,
    row.approach,
    row.state,
    row.creatorIp,
    Date.now(),
  );
}

/** The operator's fleet, oldest first. */
export function userAgentsListByOwner(owner: string): UserAgentRow[] {
  return db
    .prepare("SELECT * FROM user_agents WHERE owner = ? AND active = 1 ORDER BY created_at")
    .all(owner.toLowerCase()) as unknown as UserAgentRow[];
}

export function userAgentByOwner(owner: string): UserAgentRow | undefined {
  return userAgentsListByOwner(owner)[0];
}

export function userAgentSetState(name: string, state: string): void {
  db.prepare("UPDATE user_agents SET state = ? WHERE name = ?").run(state, name);
}

export function userAgentSetIdentity(name: string, agentId: string, txHash: string | null): void {
  db.prepare("UPDATE user_agents SET agent_id = ?, identity_tx = COALESCE(?, identity_tx) WHERE name = ?").run(
    agentId,
    txHash,
    name,
  );
}

export function userAgentSetHandleTx(name: string, txHash: string | null): void {
  db.prepare("UPDATE user_agents SET handle_tx = COALESCE(?, handle_tx) WHERE name = ?").run(txHash, name);
}

export function userAgentSetMandate(name: string, mandate: string | null): void {
  db.prepare("UPDATE user_agents SET mission = ? WHERE name = ?").run(mandate, name);
}

export function userAgentSetApproach(name: string, approach: string): void {
  db.prepare("UPDATE user_agents SET approach = ? WHERE name = ?").run(approach, name);
}

/** Replace the stored strategy wholesale — used when the Risk preset changes. */
export function userAgentSetStrategy(name: string, strategyJson: string): void {
  db.prepare("UPDATE user_agents SET strategy = ? WHERE name = ?").run(strategyJson, name);
}

// ── chat, rules, confirmations ──────────────────────────────────────────────
//
// The living-agent surface. Chat messages are the conversation; rules are the
// operator's persistent free-text constraints (they can only tighten behaviour
// — numbers loosen only through an explicit Risk change); a pending
// confirmation is a proposed action or change waiting for the operator's
// signature. At most one pending confirmation per agent: proposing a new one
// cancels the old, which keeps "yes" unambiguous.

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    role TEXT NOT NULL,              -- operator | agent
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_agent ON chat_messages(agent, id);

  CREATE TABLE IF NOT EXISTS agent_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    text TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rules_agent ON agent_rules(agent, id);

  CREATE TABLE IF NOT EXISTS pending_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,           -- JSON, exact proposed action/change
    summary TEXT NOT NULL,           -- what the operator is shown and signs over
    conflicts TEXT,                  -- JSON PolicyConflict[] when it is an override
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS confirmations_agent ON pending_confirmations(agent, id);
`);

export function chatAdd(agent: string, role: "operator" | "agent", content: string): number {
  const r = db
    .prepare("INSERT INTO chat_messages (agent, role, content, created_at) VALUES (?, ?, ?, ?)")
    .run(agent, role, content, Date.now());
  return Number(r.lastInsertRowid);
}

export function chatHistory(
  agent: string,
  limit = 40,
): Array<{ id: number; role: string; content: string; created_at: number }> {
  return (
    db
      .prepare("SELECT id, role, content, created_at FROM chat_messages WHERE agent = ? ORDER BY id DESC LIMIT ?")
      .all(agent, limit) as Array<{ id: number; role: string; content: string; created_at: number }>
  ).reverse();
}

/** Operator messages in the last 24h — the chat inference budget's meter. */
export function chatOperatorMessagesLast24h(agent: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) n FROM chat_messages WHERE agent = ? AND role = 'operator' AND created_at > ?",
    )
    .get(agent, Date.now() - 24 * 3600 * 1000) as { n: number };
  return row.n;
}

export interface AgentRuleRow {
  id: number;
  agent: string;
  text: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export const MAX_RULES_PER_AGENT = 20;
export const MAX_RULE_LENGTH = 200;

export function rulesOf(agent: string): AgentRuleRow[] {
  return db
    .prepare("SELECT * FROM agent_rules WHERE agent = ? ORDER BY id")
    .all(agent) as unknown as AgentRuleRow[];
}

export function ruleAdd(agent: string, text: string): number {
  const r = db
    .prepare("INSERT INTO agent_rules (agent, text, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
    .run(agent, text, Date.now(), Date.now());
  return Number(r.lastInsertRowid);
}

export function ruleSetEnabled(agent: string, id: number, enabled: boolean): boolean {
  const r = db
    .prepare("UPDATE agent_rules SET enabled = ?, updated_at = ? WHERE agent = ? AND id = ?")
    .run(enabled ? 1 : 0, Date.now(), agent, id);
  return r.changes > 0;
}

export function ruleEdit(agent: string, id: number, text: string): boolean {
  const r = db
    .prepare("UPDATE agent_rules SET text = ?, updated_at = ? WHERE agent = ? AND id = ?")
    .run(text, Date.now(), agent, id);
  return r.changes > 0;
}

export function ruleDelete(agent: string, id: number): boolean {
  const r = db.prepare("DELETE FROM agent_rules WHERE agent = ? AND id = ?").run(agent, id);
  return r.changes > 0;
}

export interface PendingConfirmationRow {
  id: number;
  agent: string;
  type: string;
  payload: string;
  summary: string;
  conflicts: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

/** Propose something; any earlier live proposal for this agent is cancelled. */
export function confirmationCreate(
  agent: string,
  type: string,
  payload: string,
  summary: string,
  conflicts: string | null,
  ttlMs = 5 * 60_000,
): number {
  db.prepare(
    "UPDATE pending_confirmations SET consumed_at = ? WHERE agent = ? AND consumed_at IS NULL",
  ).run(Date.now(), agent);
  const r = db
    .prepare(
      `INSERT INTO pending_confirmations (agent, type, payload, summary, conflicts, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(agent, type, payload, summary, conflicts, Date.now(), Date.now() + ttlMs);
  return Number(r.lastInsertRowid);
}

export function confirmationActive(agent: string): PendingConfirmationRow | undefined {
  const row = db
    .prepare(
      "SELECT * FROM pending_confirmations WHERE agent = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get(agent) as PendingConfirmationRow | undefined;
  if (!row) return undefined;
  if (row.expires_at < Date.now()) return undefined;
  return row;
}

/** Consume exactly once. Returns the row only on the first successful consume. */
export function confirmationConsume(agent: string, id: number): PendingConfirmationRow | undefined {
  const row = db
    .prepare("SELECT * FROM pending_confirmations WHERE agent = ? AND id = ?")
    .get(agent, id) as PendingConfirmationRow | undefined;
  if (!row || row.consumed_at !== null || row.expires_at < Date.now()) return undefined;
  const r = db
    .prepare("UPDATE pending_confirmations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
    .run(Date.now(), id);
  return r.changes > 0 ? row : undefined;
}

/** Agents the activation sweep should look at: not yet active, or active but missing identity. */
/**
 * Agents that have not finished activating: still waiting on capital, mid-way
 * through it, or somehow without an identity.
 *
 * "Not active" was the old test, and it swept up states that have nothing to do
 * with activation — a paused agent is fully activated and stays paused, but it
 * matched, sat at the head of the queue by age, and the sweep spent its one
 * attempt a minute on it while newly funded agents waited behind. An agent
 * parked in error_recoverable is deliberately parked and is not retried here.
 */
export function userAgentsNeedingActivation(): UserAgentRow[] {
  return db
    .prepare(
      `SELECT * FROM user_agents
       WHERE active = 1
         AND (agent_id IS NULL OR state IN ('awaiting_funding', 'activating'))
         AND state != 'error_recoverable'
       ORDER BY created_at`,
    )
    .all() as unknown as UserAgentRow[];
}

export function userAgentsUngranted(): UserAgentRow[] {
  return db
    .prepare("SELECT * FROM user_agents WHERE active = 1 AND granted = 0 ORDER BY created_at")
    .all() as unknown as UserAgentRow[];
}

export function userAgentMarkGranted(name: string): void {
  db.prepare("UPDATE user_agents SET granted = 1 WHERE name = ?").run(name);
}

export function userAgents(): UserAgentRow[] {
  return db
    .prepare("SELECT * FROM user_agents WHERE active = 1 ORDER BY created_at")
    .all() as unknown as UserAgentRow[];
}

export function userAgentByName(name: string): UserAgentRow | undefined {
  return db.prepare("SELECT * FROM user_agents WHERE name = ?").get(name) as
    | UserAgentRow
    | undefined;
}

export function userAgentCount(): number {
  const row = db.prepare("SELECT COUNT(*) n FROM user_agents").get() as { n: number };
  return row.n;
}

export function userAgentsCreatedBy(ip: string, sinceMs: number): number {
  const row = db
    .prepare("SELECT COUNT(*) n FROM user_agents WHERE creator_ip = ? AND created_at > ?")
    .get(ip, Date.now() - sinceMs) as { n: number };
  return row.n;
}

export function settingGet(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function settingSet(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Lifetime volume and trade count per market, accumulated by the history walk.
 *
 * The totals and the cursor that produced them are written together: a crash
 * between them would either double-count a range or skip one, and both are
 * wrong in a number the site presents as fact.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS market_history (
    market_id TEXT PRIMARY KEY,
    volume_usdc TEXT NOT NULL DEFAULT '0',
    trade_count INTEGER NOT NULL DEFAULT 0
  );
`);

export function applyHistoryRange(
  deltas: Map<string, { usdc: bigint; count: number }>,
  nextCursor: string,
): void {
  const add = db.prepare(
    `INSERT INTO market_history (market_id, volume_usdc, trade_count)
     VALUES (?, ?, ?)
     ON CONFLICT(market_id) DO UPDATE SET
       volume_usdc = CAST(CAST(market_history.volume_usdc AS INTEGER) + CAST(excluded.volume_usdc AS INTEGER) AS TEXT),
       trade_count = market_history.trade_count + excluded.trade_count`,
  );
  const setCursor = db.prepare(
    "INSERT INTO settings (key, value) VALUES ('history_cursor_block', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [marketId, d] of deltas) add.run(marketId, d.usdc.toString(), d.count);
    setCursor.run(nextCursor);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * What each market is called.
 *
 * The chain knows a market as an id; a reader knows it as a ticker. The id is
 * what every internal path carries, so without a shared place to look the name
 * up, "buy 0.75 USDC on market 11" is what the operator reads about a coin
 * their agent chose by name. The registry is read from the chain once per
 * market and kept here because the three processes do not share memory: the
 * orchestrator writes decisions, the API answers screens, and both need the
 * same answer.
 *
 * Blank symbols are never written over a known one — a name read that lost to
 * a rate limit is our failure, not a rename.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS market_facts (
    market_id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT ''
  );
`);

export function rememberMarkets(
  markets: Array<{ id: bigint | string; symbol: string; name: string }>,
): void {
  const put = db.prepare(
    `INSERT INTO market_facts (market_id, symbol, name)
     VALUES (?, ?, ?)
     ON CONFLICT(market_id) DO UPDATE SET
       symbol = CASE WHEN excluded.symbol <> '' THEN excluded.symbol ELSE market_facts.symbol END,
       name   = CASE WHEN excluded.name   <> '' THEN excluded.name   ELSE market_facts.name   END`,
  );
  // Row by row on purpose: unlike the history walk, no two of these have to
  // land together, so there is nothing to gain from holding a write lock that
  // three processes are competing for.
  for (const m of markets) put.run(m.id.toString(), m.symbol ?? "", m.name ?? "");
}

/** The ticker for one market, or null while the chain read has not landed. */
export function marketSymbol(id: bigint | string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const row = db.prepare("SELECT symbol FROM market_facts WHERE market_id = ?").get(id.toString()) as
    | { symbol: string }
    | undefined;
  return row?.symbol ? row.symbol : null;
}

/** Every known ticker at once, for screens that label a whole list. */
export function marketSymbols(): Map<string, string> {
  const rows = db.prepare("SELECT market_id, symbol FROM market_facts WHERE symbol <> ''").all() as Array<{
    market_id: string;
    symbol: string;
  }>;
  return new Map(rows.map((r) => [r.market_id, r.symbol]));
}

/** How a market is named in prose: its ticker, or the id when it has none. */
export function marketLabel(id: bigint | string | number): string {
  return marketSymbol(id) ?? `market ${id}`;
}

export function marketHistory(): Array<{ marketId: string; volumeUsdc: string; tradeCount: number }> {
  return (
    db.prepare("SELECT market_id, volume_usdc, trade_count FROM market_history").all() as Array<{
      market_id: string;
      volume_usdc: string;
      trade_count: number;
    }>
  ).map((r) => ({ marketId: r.market_id, volumeUsdc: r.volume_usdc, tradeCount: r.trade_count }));
}

export function llmCallRecord(
  agent: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): void {
  db.prepare(
    "INSERT INTO llm_calls (agent, model, tokens_in, tokens_out, at) VALUES (?, ?, ?, ?, ?)",
  ).run(agent, model, tokensIn, tokensOut, Date.now());
}

export function llmCallsLast24h(agent: string): number {
  const row = db
    .prepare("SELECT COUNT(*) n FROM llm_calls WHERE agent = ? AND at > ?")
    .get(agent, Date.now() - 24 * 3600 * 1000) as { n: number };
  return row.n;
}

export function heartbeat(): void {
  db.prepare(
    "INSERT INTO heartbeat (id, at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at",
  ).run(Date.now());
}

export function lastHeartbeatAt(): number {
  const row = db.prepare("SELECT at FROM heartbeat WHERE id = 1").get() as { at: number } | undefined;
  return row?.at ?? 0;
}
