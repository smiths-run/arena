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

const DIR = new URL("../data", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

export const db = new DatabaseSync(`${DIR}/agents.db`);

db.exec(`
  PRAGMA journal_mode = WAL;

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

// ── runs ────────────────────────────────────────────────────────────────────

export function startRun(agent: string, trigger: string): number {
  const r = db
    .prepare("INSERT INTO runs (agent, trigger_kind, started_at) VALUES (?, ?, ?)")
    .run(agent, trigger, Date.now());
  return Number(r.lastInsertRowid);
}

export function finishRun(
  id: number,
  outcome: "acted" | "skipped" | "rejected" | "error",
  fields: { actionKind?: string; reason?: string; txHash?: string; usdc?: bigint; marketId?: bigint },
): void {
  db.prepare(
    `UPDATE runs SET finished_at = ?, outcome = ?, action_kind = ?, reason = ?, tx_hash = ?, usdc = ?, market_id = ?
     WHERE id = ?`,
  ).run(
    Date.now(),
    outcome,
    fields.actionKind ?? null,
    fields.reason ?? null,
    fields.txHash ?? null,
    fields.usdc?.toString() ?? null,
    fields.marketId?.toString() ?? null,
    id,
  );
}

export function recentRuns(limit = 20): unknown[] {
  return db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit);
}

export function lastRunAt(agent: string): number {
  const row = db
    .prepare("SELECT MAX(started_at) AS at FROM runs WHERE agent = ?")
    .get(agent) as { at: number | null };
  return row.at ?? 0;
}

// ── pending transactions (reconciliation) ──────────────────────────────────

export function pendingCreate(key: string, agent: string, purpose: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO pending_tx (idempotency_key, agent, purpose, state, updated_at)
     VALUES (?, ?, ?, 'created', ?)`,
  ).run(key, agent, purpose, Date.now());
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
