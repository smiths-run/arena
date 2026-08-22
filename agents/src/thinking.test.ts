/**
 * The switch, and the mandate behind it.
 *
 * Two things have to be true before a paid thinking path can go anywhere near
 * production. With no desk configured, nothing may change — the agents must
 * take exactly the route they took yesterday. And with one configured, the
 * agent must not be able to authorize more than it meant to, however the desk
 * behaves.
 *
 * The settlement itself needs Circle credentials and a live Gateway, so it is
 * proven against the running desk rather than here. What is here is everything
 * that decides whether money can move at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTS_DATA_DIR = mkdtempSync(join(tmpdir(), "agents-thinking-test-"));
process.env.MARKETS_ADDRESS ??= "0x0000000000000000000000000000000000000001";
process.env.CIRCLE_API_KEY ??= "test";
process.env.CIRCLE_ENTITY_SECRET ??= "test";
for (const i of [0, 1, 2]) {
  process.env[`AGENT_${i}_WALLET_ID`] ??= `w-${i}`;
  process.env[`AGENT_${i}_ADDRESS`] ??= `0x${String(i).repeat(40)}`;
}

const thinking = await import("./thinking.ts");

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
  const had: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    had[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(had)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("with no desk configured, nothing changes", async () => {
  await withEnv({ INFERENCE_DESK_URL: undefined }, () => {
    assert.equal(thinking.deskEnabled(), false);
    assert.equal(thinking.deskUrl(), undefined);
  });
});

test("an empty or whitespace URL is not a desk", async () => {
  await withEnv({ INFERENCE_DESK_URL: "   " }, () => {
    assert.equal(thinking.deskEnabled(), false, "a blank variable must not switch money on");
  });
});

test("a configured desk is normalised, trailing slash and all", async () => {
  await withEnv({ INFERENCE_DESK_URL: "http://localhost:42072/" }, () => {
    assert.equal(thinking.deskEnabled(), true);
    assert.equal(thinking.deskUrl(), "http://localhost:42072", "a doubled slash is a 404 waiting to happen");
  });
});

test("buying refuses outright when no desk is configured", async () => {
  await withEnv({ INFERENCE_DESK_URL: undefined }, async () => {
    await assert.rejects(
      () => thinking.buyThought({ agentName: "anvil", user: "hello" }),
      /no inference desk is configured/,
    );
  });
});

test("an agent will not pay a desk nobody named", async () => {
  // Without an allowlist the mandate has nothing to constrain, so the payment
  // must not be attempted at all rather than signed against an open payee.
  await withEnv(
    { INFERENCE_DESK_URL: "http://localhost:1", MIND_DESK_ADDRESS: undefined },
    async () => {
      await assert.rejects(
        () => thinking.buyThought({ agentName: "anvil", user: "hello" }),
        /nobody it is allowed to pay/,
      );
    },
  );
});

test("an unknown agent cannot spend anybody's money", async () => {
  await withEnv(
    { INFERENCE_DESK_URL: "http://localhost:1", MIND_DESK_ADDRESS: "0x00000000000000000000000000000000000000ff" },
    async () => {
      await assert.rejects(
        () => thinking.buyThought({ agentName: "nobody-by-that-name", user: "hello" }),
        /no agent called nobody-by-that-name/,
      );
    },
  );
});

test("the per-thought cap is bounded and configurable", async () => {
  await withEnv({ MIND_MAX_COST_USDC: undefined }, () => {
    // Two cents by default: generous against a one-cent price, far too small to
    // matter if a desk ever misbehaves.
    assert.equal(thinking.maxThoughtCost(), 20_000n);
  });
  await withEnv({ MIND_MAX_COST_USDC: "5000" }, () => {
    assert.equal(thinking.maxThoughtCost(), 5_000n);
  });
});
