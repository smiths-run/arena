/**
 * The follower engine, where the money is.
 *
 * These tests exist because every one of them is a way real funds could leave
 * a wallet without anybody meaning it: a rule that fires twice on one launch,
 * a pair of agents answering each other in a loop, a mirror that grows past
 * what its operator agreed to, or a reaction that arrives an hour after the
 * world it was answering.
 *
 * The roster and the ledger are both read at import, so the environment is
 * stood up first and every import is dynamic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTS_DATA_DIR = mkdtempSync(join(tmpdir(), "agents-triggers-test-"));
process.env.MARKETS_ADDRESS ??= "0x0000000000000000000000000000000000000001";
process.env.CIRCLE_API_KEY ??= "test";
process.env.CIRCLE_ENTITY_SECRET ??= "test";
for (const i of [0, 1, 2]) {
  process.env[`AGENT_${i}_WALLET_ID`] ??= `w-${i}`;
  process.env[`AGENT_${i}_ADDRESS`] ??= `0x${String(i).repeat(40)}`;
}

const store = await import("./store.ts");
const vs = await import("./visitor-strategy.ts");
const actors = await import("./actors.ts");
const triggers = await import("./triggers.ts");

const WALLET = {
  mfmf: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  test1: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  other: "0xcccccccccccccccccccccccccccccccccccccccc",
  stranger: "0xdddddddddddddddddddddddddddddddddddddddd",
};

function seedAgent(name: string, address: string) {
  store.userAgentCreate({
    name,
    walletId: `w-${name}`,
    address,
    strategyJson: vs.serializeStrategy(vs.planVisitorAgent({ handle: name } as never).strategy),
    mission: null,
    owner: "0x1111111111111111111111111111111111111111",
    approach: "scout",
    state: "active",
    creatorIp: null,
  });
}
for (const [name, address] of Object.entries(WALLET)) {
  if (name !== "stranger") seedAgent(name, address);
}
actors.forgetActors();

let blockAt = 1000;
function launchBy(wallet: string, marketId: string, symbol = "ABC", at = Date.now()): string {
  const id = `0x${(blockAt++).toString(16).padStart(64, "0")}:0`;
  store.eventsAppend([
    {
      id,
      type: "market_launched",
      blockNumber: BigInt(blockAt),
      logIndex: 0,
      txHash: id.split(":")[0],
      at,
      actorWallet: wallet,
      marketId,
      usdc: 1_000_000n,
      symbol,
    },
  ]);
  return id;
}

const plan = (agent: string, req: Parameters<typeof triggers.planTrigger>[1]) => {
  const p = triggers.planTrigger(agent, req);
  if ("error" in p) throw new Error(p.error);
  return p;
};

// ── writing a rule the runtime can actually honour ─────────────────────────

test("a rule naming an agent that does not exist is refused, with the near miss", () => {
  const p = triggers.planTrigger("test1", { targetHandle: "mfmm", event: "market_launched", mode: "watch" });
  assert.ok("error" in p);
  assert.match((p as { error: string }).error, /no @mfmm/);
  assert.match((p as { error: string }).error, /@mfmf/, "the near miss is offered, not chosen");
});

test("an agent cannot follow itself", () => {
  const p = triggers.planTrigger("test1", { targetHandle: "test1", event: "buy", mode: "mirror" });
  assert.ok("error" in p);
});

test("anything that can trade must say how much", () => {
  const p = triggers.planTrigger("test1", { targetHandle: "mfmf", event: "buy", mode: "mirror", sizing: "fixed" });
  assert.ok("error" in p, "a fixed size with no amount is not a size");
  const watch = plan("test1", { targetHandle: "mfmf", event: "any", mode: "watch" });
  assert.equal(watch.request.sizing, null, "watching needs no size because it spends nothing");
});

test("two agents cannot be set to answer each other", () => {
  const first = plan("test1", {
    targetHandle: "mfmf",
    event: "buy",
    mode: "mirror",
    sizing: "fixed",
    amountUsdc: 500_000n,
  });
  triggers.createTrigger("test1", first.request);

  const loop = triggers.planTrigger("mfmf", {
    targetHandle: "test1",
    event: "buy",
    mode: "mirror",
    sizing: "fixed",
    amountUsdc: 500_000n,
  });
  assert.ok("error" in loop, "the second half of a loop is refused where it is written");
  assert.match((loop as { error: string }).error, /loop/);

  // Watching is not answering, so it is still allowed.
  const watching = triggers.planTrigger("mfmf", { targetHandle: "test1", event: "any", mode: "watch" });
  assert.ok(!("error" in watching));
});

test("the summary states the size, the caps and whether limits may be crossed", () => {
  const p = plan("other", {
    targetHandle: "mfmf",
    event: "market_launched",
    mode: "mirror",
    sizing: "fixed",
    amountUsdc: 500_000n,
  });
  assert.match(p.summary, /0\.5 USDC/);
  assert.match(p.summary, /a day through this rule/);
  assert.match(p.summary, /normal risk limits still apply/);
  assert.match(p.summary, /hard limits can never be crossed/);
});

// ── sizing ─────────────────────────────────────────────────────────────────

test("sizing follows the rule and is clamped by the per-action cap", () => {
  const fixed = {
    id: -1, agent: "test1", targetHandle: "mfmf", event: "buy" as const, mode: "mirror" as const,
    sizing: "fixed" as const, amountUsdc: 500_000n, proportionBps: null,
    dailyBudgetUsdc: 10_000_000n, maxActionUsdc: 1_000_000n, overrideRisk: false,
    expiresAt: null, enabled: true, createdAt: 0,
  };
  assert.equal(triggers.sizeFor(fixed, 4_000_000n), 500_000n, "fixed ignores what they spent");

  const same = { ...fixed, sizing: "same_amount" as const, amountUsdc: null };
  assert.equal(triggers.sizeFor(same, 400_000n), 400_000n, "same amount follows theirs");
  assert.equal(triggers.sizeFor(same, 4_000_000n), 1_000_000n, "and stops at the per-action cap");

  const half = { ...fixed, sizing: "proportional" as const, amountUsdc: null, proportionBps: 5_000 };
  assert.equal(triggers.sizeFor(half, 800_000n), 400_000n, "half of theirs");
});

test("a rule that has spent its day buys nothing more", () => {
  const p = plan("other", {
    targetHandle: "mfmf", event: "buy", mode: "mirror", sizing: "fixed", amountUsdc: 1_000_000n,
  });
  const id = triggers.createTrigger("other", { ...p.request, dailyBudgetUsdc: 1_500_000n });
  const t = store.trigger(id)!;
  assert.equal(triggers.sizeFor(t, 1_000_000n), 1_000_000n);

  const fire = store.fireCreate(id, "other", "spent:1", "pending")!;
  store.fireResolve(fire, "executed", "bought", { usdc: 1_000_000n });
  assert.equal(triggers.sizeFor(t, 1_000_000n), 500_000n, "only what is left of the budget");

  const fire2 = store.fireCreate(id, "other", "spent:2", "pending")!;
  store.fireResolve(fire2, "executed", "bought", { usdc: 500_000n });
  assert.equal(triggers.sizeFor(t, 1_000_000n), 0n, "and then nothing");
});

// ── matching ───────────────────────────────────────────────────────────────

test("an awake follower is fired, a sleeping one is recorded as missed", () => {
  const p = plan("other", {
    targetHandle: "mfmf", event: "market_launched", mode: "mirror", sizing: "fixed", amountUsdc: 500_000n,
  });
  const id = triggers.createTrigger("other", p.request);

  launchBy(WALLET.mfmf, "70");
  store.markSeen("other");
  const awake = triggers.matchNewEvents();
  assert.equal(awake.fired, 1);
  assert.equal(store.firesPending("other").length, 1);

  // Draining, then the same agent asleep for the next launch.
  for (const f of store.firesPending("other")) store.fireResolve(f.id, "executed", "done", { usdc: 500_000n });
  store.db.prepare("UPDATE agent_seen SET at = 0 WHERE agent = ?").run("other");
  launchBy(WALLET.mfmf, "71");
  const asleep = triggers.matchNewEvents();
  assert.equal(asleep.fired, 0);
  assert.equal(asleep.missed, 1);
  const missed = store.firesOf("other", 1)[0];
  assert.equal(missed.status, "missed_offline");
  assert.match(missed.detail ?? "", /not awake/);
});

test("the same event cannot fire the same rule twice", () => {
  const p = plan("test1", {
    targetHandle: "mfmf", event: "market_launched", mode: "mirror", sizing: "fixed", amountUsdc: 500_000n,
  });
  triggers.createTrigger("test1", p.request);
  store.markSeen("test1");

  launchBy(WALLET.mfmf, "72");
  const first = triggers.matchNewEvents();
  assert.equal(first.fired, 1);

  // Rewinding the cursor is what a restart or a reconnect looks like.
  store.settingSet("trigger_cursor_seq", "0");
  const again = triggers.matchNewEvents();
  assert.equal(again.fired, 0, "re-reading the chain buys nothing a second time");
});

test("a rule answers what happens after it, not the history behind it", () => {
  launchBy(WALLET.mfmf, "73", "OLD", Date.now() - 3600_000);
  store.settingSet("trigger_cursor_seq", "0");
  const p = plan("test1", {
    targetHandle: "mfmf", event: "market_launched", mode: "mirror", sizing: "fixed", amountUsdc: 500_000n,
  });
  triggers.createTrigger("test1", p.request);
  store.markSeen("test1");
  const r = triggers.matchNewEvents();
  const fired = store.firesOf("test1", 10).filter((f) => f.detail?.includes("OLD"));
  assert.equal(fired.length, 0, "saving a rule must not replay the backfill");
  assert.ok(r.considered > 0, "the events were seen, and deliberately not acted on");
});

test("nobody follows a wallet that is not an agent", () => {
  const p = plan("test1", { targetHandle: "mfmf", event: "any", mode: "watch" });
  triggers.createTrigger("test1", p.request);
  store.markSeen("test1");
  const before = store.firesOf("test1", 50).length;
  launchBy(WALLET.stranger, "74");
  triggers.matchNewEvents();
  assert.equal(store.firesOf("test1", 50).length, before, "an unattributed wallet triggers nothing");
});

test("only one caller can act on a fire", () => {
  const p = plan("other", { targetHandle: "mfmf", event: "any", mode: "watch" });
  const id = triggers.createTrigger("other", p.request);
  const fire = store.fireCreate(id, "other", "claim:1", "pending")!;
  assert.equal(store.fireClaim(fire), true, "the first caller takes it");
  assert.equal(store.fireClaim(fire), false, "the second finds it gone");
});

test("a fire nobody came back for expires instead of waiting", () => {
  const p = plan("other", { targetHandle: "mfmf", event: "any", mode: "watch" });
  const id = triggers.createTrigger("other", p.request);
  const fire = store.fireCreate(id, "other", "stale:1", "pending")!;
  store.db.prepare("UPDATE trigger_fires SET created_at = ? WHERE id = ?").run(Date.now() - 600_000, fire);
  assert.ok(store.firesExpire(90_000) >= 1);
  const row = store.firesOf("other", 50).find((f) => f.eventId === "stale:1")!;
  assert.equal(row.status, "expired");
});

test("awake means seen recently, and nothing else", () => {
  store.markSeen("test1");
  assert.equal(triggers.isAwake("test1"), true);
  store.db.prepare("UPDATE agent_seen SET at = ? WHERE agent = ?").run(Date.now() - triggers.AWAKE_WINDOW_MS - 1, "test1");
  assert.equal(triggers.isAwake("test1"), false);
  assert.equal(triggers.isAwake("nobody-here"), false);
});

test("a trade our own trigger produced never triggers anyone", () => {
  const p = plan("test1", { targetHandle: "mfmf", event: "any", mode: "watch" });
  triggers.createTrigger("test1", p.request);
  store.markSeen("test1");

  // @mfmf's buy, but made by a run this platform started because of a trigger:
  // the shape of one half of a mirror loop.
  const runId = store.startRun("mfmf", "trigger");
  store.pendingCreate("idem-loop", "mfmf", "buy", "logical-loop", runId);
  const txHash = `0x${"ee".repeat(32)}`;
  store.db.prepare("UPDATE pending_tx SET tx_hash = ? WHERE idempotency_key = 'idem-loop'").run(txHash);
  assert.equal(store.txIsTriggerOrigin(txHash), true);

  store.eventsAppend([
    {
      id: `${txHash}:0`,
      type: "buy",
      blockNumber: 99_000n,
      logIndex: 0,
      txHash,
      at: Date.now(),
      actorWallet: WALLET.mfmf,
      marketId: "75",
      usdc: 1_000_000n,
    },
  ]);
  const before = store.firesOf("test1", 50).length;
  triggers.matchNewEvents();
  assert.equal(store.firesOf("test1", 50).length, before, "the loop brake holds");
});
