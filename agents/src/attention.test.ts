/**
 * Deciding when a thought is worth buying.
 *
 * This gate is the difference between an agent that spends its whole allowance
 * before breakfast and one that still has something left when the market
 * moves. Each rule is pinned separately, because the failure that matters is
 * not "the gate is wrong on average" — it is one rule quietly never firing, and
 * an agent that either never thinks or never stops.
 *
 * The store reads config at import, so the environment is stood up first and
 * the imports are dynamic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTS_DATA_DIR = mkdtempSync(join(tmpdir(), "agents-attention-test-"));
process.env.MARKETS_ADDRESS ??= "0x0000000000000000000000000000000000000001";
process.env.CIRCLE_API_KEY ??= "test";
process.env.CIRCLE_ENTITY_SECRET ??= "test";
for (const i of [0, 1, 2]) {
  process.env[`AGENT_${i}_WALLET_ID`] ??= `w-${i}`;
  process.env[`AGENT_${i}_ADDRESS`] ??= `0x${String(i).repeat(40)}`;
}

const store = await import("./store.ts");
const { shouldThink, QUIET_FLOOR_MS } = await import("./attention.ts");

const MINE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const THEIRS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const strategy = (maxCallsPerDay: number) =>
  ({ llm: { enabled: true, maxCallsPerDay } }) as unknown as Parameters<typeof shouldThink>[0]["strategy"];

const agent = (name: string, cap = 40) => ({
  agentName: name,
  address: MINE,
  strategy: strategy(cap),
});

/**
 * These tests share one ledger, and "has anything happened?" is a question about
 * the whole ledger — so a test that wants a quiet world has to say so.
 */
function quietWorld(): void {
  store.db.exec("DELETE FROM platform_events");
}

/** One event on the ledger, attributed to a wallet, at a moment. */
let seq = 0;
function event(wallet: string, atMs: number) {
  seq += 1;
  store.eventsAppend([
    {
      id: `0xtx${seq}:${seq}`,
      type: "buy",
      blockNumber: String(1000 + seq),
      logIndex: seq,
      txHash: `0xtx${seq}`,
      at: atMs,
      actorWallet: wallet,
      marketId: "1",
      usdc: "500000",
      tokens: "1000",
      symbol: "TEST",
      name: "Test",
    },
  ] as Parameters<typeof store.eventsAppend>[0]);
}

test("an agent that has never thought takes a first look", () => {
  const a = shouldThink(agent("newcomer"));
  assert.equal(a.think, true);
  assert.match(a.reason, /first look/i);
});

test("a spent budget refuses however interesting the world got", () => {
  const name = "spender";
  quietWorld();
  for (let i = 0; i < 5; i++) store.llmCallRecord(name, "claude-opus-5", 100, 10);
  event(THEIRS, Date.now() + 1_000);

  const a = shouldThink({ ...agent(name, 5) });
  assert.equal(a.think, false, "the cap is a ceiling, not a suggestion");
  assert.match(a.reason, /budget spent \(5\/5\)/);
});

test("somebody else acting is worth a thought", () => {
  const name = "watcher";
  quietWorld();
  store.llmCallRecord(name, "claude-opus-5", 100, 10);
  const last = store.llmLastCallAtFor(name)!;
  event(THEIRS, last + 1_000);

  const a = shouldThink(agent(name));
  assert.equal(a.think, true);
  assert.match(a.reason, /1 event since the last look/);
});

test("an agent's own trade does not wake it", () => {
  const name = "narcissist";
  quietWorld();
  store.llmCallRecord(name, "claude-opus-5", 100, 10);
  const last = store.llmLastCallAtFor(name)!;
  event(MINE, last + 1_000);

  const a = shouldThink(agent(name), last + 2_000);
  assert.equal(a.think, false, "an agent answering itself would never stop");
  assert.match(a.reason, /nothing has happened/i);
});

test("a quiet world lets the agent doze, but not forever", () => {
  const name = "sleeper";
  quietWorld();
  store.llmCallRecord(name, "claude-opus-5", 100, 10);
  const last = store.llmLastCallAtFor(name)!;

  const soon = shouldThink(agent(name), last + 10 * 60_000);
  assert.equal(soon.think, false);
  assert.match(soon.reason, /since the last look 10m ago/);

  const later = shouldThink(agent(name), last + QUIET_FLOOR_MS + 1_000);
  assert.equal(later.think, true, "an economy that never moves must not silence the agent for good");
  assert.match(later.reason, /looking anyway/i);
});

test("a run woken on purpose always thinks", () => {
  const name = "answerer";
  quietWorld();
  store.llmCallRecord(name, "claude-opus-5", 100, 10);
  const last = store.llmLastCallAtFor(name)!;

  // No new events, well inside the quiet floor: everything else says no.
  const quiet = shouldThink(agent(name), last + 60_000);
  assert.equal(quiet.think, false);

  const woken = shouldThink({ ...agent(name), wakeReason: "@bobo bought SIGNAL" }, last + 60_000);
  assert.equal(woken.think, true, "a run that exists to answer something must not answer with a heuristic");
  assert.match(woken.reason, /woken on purpose/i);
});

test("the budget outranks even a purposeful wake", () => {
  const name = "broke";
  quietWorld();
  for (let i = 0; i < 3; i++) store.llmCallRecord(name, "claude-opus-5", 100, 10);
  const a = shouldThink({ ...agent(name, 3), wakeReason: "@bobo bought SIGNAL" });
  assert.equal(a.think, false, "nothing may spend an allowance that is already gone");
  assert.match(a.reason, /budget spent/);
});

test("a quiet day costs a twelfth of a spent quota", () => {
  // The floor is the bill in a dead economy: 24h / 2h = 12 thoughts, against
  // the 150 a quota was buying to be blind for most of the day.
  assert.equal(Math.floor((24 * 3_600_000) / QUIET_FLOOR_MS), 12);
});
