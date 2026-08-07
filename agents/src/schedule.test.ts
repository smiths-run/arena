/**
 * The scheduler's precedence order, pinned. Each rule exists because of a real
 * consequence: a held agent that runs anyway can double-spend; an operator
 * request that cannot beat a pause makes "run now" a lie; a pause that a
 * schedule can slip past is not a pause.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type ScheduleInput } from "./schedule.ts";

const idle: ScheduleInput = {
  held: false,
  requested: false,
  paused: false,
  once: false,
  sinceLastRunMs: 120_000,
  cooldownMs: 60_000,
};

test("an idle agent past its cooldown runs on schedule", () => {
  assert.deepEqual(decide(idle), { run: true, trigger: "schedule" });
});

test("cooldown holds a scheduled run back", () => {
  const v = decide({ ...idle, sinceLastRunMs: 10_000 });
  assert.deepEqual(v, { run: false, why: "cooldown" });
});

test("held blocks everything, including an operator request", () => {
  const v = decide({ ...idle, held: true, requested: true });
  assert.deepEqual(v, { run: false, why: "held" });
});

test("an operator request runs immediately, through pause and cooldown", () => {
  const v = decide({ ...idle, requested: true, paused: true, sinceLastRunMs: 0 });
  assert.deepEqual(v, { run: true, trigger: "operator" });
});

test("paused blocks scheduled runs", () => {
  const v = decide({ ...idle, paused: true });
  assert.deepEqual(v, { run: false, why: "paused" });
});

test("--once ignores cooldown but not pause", () => {
  assert.deepEqual(decide({ ...idle, once: true, sinceLastRunMs: 0 }), {
    run: true,
    trigger: "manual",
  });
  assert.deepEqual(decide({ ...idle, once: true, paused: true }), { run: false, why: "paused" });
});
