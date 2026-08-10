/**
 * The operator-override model, pinned.
 *
 * Two layers with different constitutions: agent policy yields to a signed
 * operator confirmation, the hard layer yields to nobody. And the confirmation
 * store must make "yes" unambiguous — one live proposal per agent, consumed
 * exactly once, dead on expiry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideLayered, evaluate, type Action, type Observation } from "./policy.ts";
import { crossesOperatorRule, statedConflicts } from "./chat.ts";
import { STRATEGIES } from "./config.ts";

process.env.AGENTS_DATA_DIR = mkdtempSync(join(tmpdir(), "smiths-operator-"));
const store = await import("./store.ts");

const strategy = { ...STRATEGIES.anvil, maxTradeUsdc: 1_000_000n, dailySpendUsdc: 6_000_000n };

function obs(over: Partial<Observation> = {}): Observation {
  return {
    balanceUsdc: 50_000_000n,
    spent24h: 0n,
    quotedImpactBps: 50n,
    positionTokens: 0n,
    ownMarketCount: 0,
    ...over,
  };
}

const buy = (usdcIn: bigint): Action => ({ kind: "buy", marketId: 1n, usdcIn });

test("within policy: allowed, and consistent with the autonomous verdict", () => {
  const d = decideLayered(buy(500_000n), strategy, obs());
  assert.equal(d.status, "allowed");
  assert.equal(evaluate(buy(500_000n), strategy, obs()).ok, true);
});

test("over the agent's limit but under the contract's: an override, not a wall", () => {
  const d = decideLayered(buy(4_000_000n), strategy, obs());
  assert.equal(d.status, "needs_override");
  if (d.status !== "needs_override") return;
  assert.ok(d.conflicts.some((c) => c.rule === "max trade"));
  // The autonomous path still refuses outright — overrides are for operators.
  assert.equal(evaluate(buy(4_000_000n), strategy, obs()).ok, false);
});

test("over the contract's hard cap: rejected, no signature can help", () => {
  const d = decideLayered(buy(6_000_000n), strategy, obs());
  assert.equal(d.status, "hard_rejected");
});

test("the operating reserve is hard: an agent must keep the gas to act at all", () => {
  const d = decideLayered(buy(4_000_000n), strategy, obs({ balanceUsdc: 4_100_000n }));
  assert.equal(d.status, "hard_rejected");
  if (d.status !== "hard_rejected") return;
  assert.match(d.reason, /reserve/);
});

test("selling more than is held is hard, not an override", () => {
  const d = decideLayered(
    { kind: "sell", marketId: 1n, tokens: 10n },
    strategy,
    obs({ positionTokens: 5n }),
  );
  assert.equal(d.status, "hard_rejected");
});

test("a blocked market is agent policy — the operator may cross it knowingly", () => {
  const s = { ...strategy, blockedMarkets: [1n] };
  const d = decideLayered(buy(500_000n), s, obs());
  assert.equal(d.status, "needs_override");
  if (d.status !== "needs_override") return;
  assert.ok(d.conflicts.some((c) => c.rule === "blocked market"));
});

// ── the confirmation store ───────────────────────────────────────────────────

test("one live proposal per agent: a new one replaces the old", () => {
  const a = store.confirmationCreate("conftest", "action", "{}", "first", null);
  const b = store.confirmationCreate("conftest", "action", "{}", "second", null);
  const active = store.confirmationActive("conftest");
  assert.equal(active?.id, b);
  assert.notEqual(active?.id, a);
});

test("a confirmation is consumed exactly once", () => {
  const id = store.confirmationCreate("oncetest", "action", "{}", "the one", null);
  assert.ok(store.confirmationConsume("oncetest", id));
  assert.equal(store.confirmationConsume("oncetest", id), undefined);
});

test("an expired confirmation neither shows nor consumes", () => {
  const id = store.confirmationCreate("exptest", "action", "{}", "stale", null, -1);
  assert.equal(store.confirmationActive("exptest"), undefined);
  assert.equal(store.confirmationConsume("exptest", id), undefined);
});

test("consuming one agent's confirmation from another agent's name fails", () => {
  const id = store.confirmationCreate("owner-a", "action", "{}", "mine", null);
  assert.equal(store.confirmationConsume("owner-b", id), undefined);
  assert.ok(store.confirmationConsume("owner-a", id));
});

// ── rules ────────────────────────────────────────────────────────────────────

test("rules round-trip with enable, edit and delete", () => {
  const id = store.ruleAdd("ruletest", "Never buy $DOG.");
  assert.equal(store.rulesOf("ruletest").length, 1);
  assert.ok(store.ruleSetEnabled("ruletest", id, false));
  assert.equal(store.rulesOf("ruletest")[0].enabled, 0);
  assert.ok(store.ruleEdit("ruletest", id, "Never buy $DOG or $CAT."));
  assert.equal(store.rulesOf("ruletest")[0].text, "Never buy $DOG or $CAT.");
  assert.ok(store.ruleDelete("ruletest", id));
  assert.equal(store.rulesOf("ruletest").length, 0);
});

// ── which credential a confirmation demands ────────────────────────────────
//
// The pilot grant is a session; a signature is an override. Everything the
// operator's own rules permit rides the session, and only crossing one of
// those rules brings the wallet back. Getting this wrong in the permissive
// direction executes an override nobody agreed to, which is why unreadable
// conflict data is treated as a crossing rather than as none.

test("a proposal inside the operator's rules needs no signature", () => {
  assert.equal(crossesOperatorRule({ conflicts: null }), false);
  assert.equal(crossesOperatorRule({ conflicts: "[]" }), false, "an empty list is not a conflict");
});

test("a proposal that crosses a rule demands the wallet", () => {
  const conflicts = JSON.stringify([{ rule: "max trade", detail: "2 USDC over the 1 USDC limit" }]);
  assert.equal(crossesOperatorRule({ conflicts }), true);
});

test("unreadable conflict data is treated as a crossing, not as none", () => {
  assert.equal(crossesOperatorRule({ conflicts: "{not json" }), true);
  assert.equal(crossesOperatorRule({ conflicts: '"a string"' }), true, "valid JSON, wrong shape");
  assert.equal(statedConflicts({ conflicts: "{not json" })[0].rule, "unreadable");
});
