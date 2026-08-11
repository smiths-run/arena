/**
 * Naming whoever acted.
 *
 * The rule that started this work — "buy every coin launched by @mfmf" — is
 * unobservable unless a wallet can be turned into a handle deterministically.
 * These tests pin the two halves that matter: a wallet we know resolves to its
 * agent, and a wallet we do not know stays honestly nameless rather than being
 * matched to something that merely looks similar.
 *
 * The roster reads config at import, so the environment is stood up first and
 * the imports are dynamic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTS_DATA_DIR = mkdtempSync(join(tmpdir(), "agents-actors-test-"));
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

const MFMF = "0xAAaAaAAAaAAAaAAaaAaaAAaAaaAAAAAaAAAAaaAA";
const STRANGER = "0xbbbbBBBbbBbBBbbbBbBbBBbBBBbBbBbBBBBBBBbb";

store.userAgentCreate({
  name: "mfmf",
  walletId: "w-mfmf",
  address: MFMF,
  strategyJson: vs.serializeStrategy(vs.planVisitorAgent({ handle: "mfmf" } as never).strategy),
  mission: null,
  owner: "0x1111111111111111111111111111111111111111",
  approach: "scout",
  state: "active",
  creatorIp: null,
});
actors.forgetActors();

test("a wallet that belongs to an agent resolves to its handle, whatever its case", () => {
  assert.equal(actors.actorOf(MFMF).handle, "mfmf");
  assert.equal(actors.actorOf(MFMF.toLowerCase()).handle, "mfmf");
  assert.equal(actors.actorOf(MFMF).kind, "visitor");
});

test("a wallet we do not know is named as external, never guessed", () => {
  const stranger = actors.actorOf(STRANGER);
  assert.equal(stranger.handle, null);
  assert.equal(stranger.agentId, null);
  assert.equal(stranger.kind, "external");
  assert.equal(actors.nameOf(stranger), "external wallet");
});

test("a handle resolves back to its wallet, with or without the @", () => {
  assert.equal(actors.actorByHandle("@mfmf")?.wallet, MFMF.toLowerCase());
  assert.equal(actors.actorByHandle("MFMF")?.wallet, MFMF.toLowerCase());
  assert.equal(actors.actorByHandle("nobody"), null);
});

test("a mistyped handle offers the near miss instead of resolving to it", () => {
  assert.equal(actors.actorByHandle("mfmm"), null, "a typo must not resolve");
  assert.deepEqual(actors.nearestHandles("mfmm"), ["mfmf"]);
  assert.deepEqual(actors.nearestHandles("zzzzzzzz"), [], "no near miss is not a near miss");
});
