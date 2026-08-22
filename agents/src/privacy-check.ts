/**
 * Can a stranger read an operator's private side?
 *
 *   npm run check:privacy
 *
 * The attack this closes is not hypothetical: the agents directory publishes
 * every agent's handle and its owner's wallet, so before this the whole of the
 * "private" surface was reachable by copying an address off a public page.
 *
 * This runs against a throwaway ledger and a real server, playing both parts —
 * the operator with something to hide and the stranger who knows their address.
 * It is kept as a command rather than folded into the unit suite because it
 * needs the server and the environment, and because a privacy property is
 * worth being able to re-prove on demand rather than once.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const DIR = mkdtempSync(join(tmpdir(), "privacy-"));
const PORT = 42197;
process.env.AGENTS_DATA_DIR = DIR;

const store = await import("./store.ts");
const vs = await import("./visitor-strategy.ts");
const actors = await import("./actors.ts");
const triggers = await import("./triggers.ts");

const victim = privateKeyToAccount(generatePrivateKey());
const attacker = privateKeyToAccount(generatePrivateKey());

store.userAgentCreate({
  name: "bobo", walletId: "w-bobo", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  strategyJson: vs.serializeStrategy(vs.planVisitorAgent({ handle: "bobo" } as never).strategy),
  mission: null, owner: victim.address.toLowerCase(), approach: "scout", state: "active", creatorIp: null,
});
store.userAgentCreate({
  name: "evilagent", walletId: "w-evil", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  strategyJson: vs.serializeStrategy(vs.planVisitorAgent({ handle: "evilagent" } as never).strategy),
  mission: null, owner: attacker.address.toLowerCase(), approach: "scout", state: "active", creatorIp: null,
});
actors.forgetActors();

store.chatAdd("bobo", "operator", "SECRET: my edge is buying TESTOOT before the others notice");
store.chatAdd("bobo", "agent", "understood, keeping that between us");
store.ruleAdd("bobo", "SECRET RULE: never sell before 20:00 UTC");
const p = triggers.planTrigger("bobo", { targetHandle: "evilagent", event: "buy", mode: "watch" });
if (!("error" in p)) triggers.createTrigger("bobo", p.request);

const server = spawn(process.execPath, ["--env-file=.env", "src/serve.ts"], {
  cwd: "/Users/erenyegit/dev/arena/agents",
  env: { ...process.env, AGENTS_DATA_DIR: DIR, RECEIPTS_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
await new Promise<void>((ok, bad) => {
  server.stdout.on("data", (b) => String(b).includes("receipts api") && ok());
  server.stderr.on("data", (b) => process.stderr.write(b));
  setTimeout(() => bad(new Error("server never came up")), 20_000);
});

const base = `http://localhost:${PORT}`;
const grantFor = async (a: typeof victim, expiry = Date.now() + 3600_000) => ({
  "x-smiths-owner": a.address,
  "x-smiths-expiry": String(expiry),
  "x-smiths-signature": await a.signMessage({
    message: `Smiths Run: pilot ${a.address.toLowerCase()} until ${expiry}`,
  }),
});
const get = async (path: string, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, { headers });
  return { status: r.status, body: (await r.json()) as any };
};

// A paid thought for each, so a bill that leaked would have something to leak.
store.llmCallRecord("bobo", "claude-opus-5", 500, 120, 0, 0, "desk", 10_000n, "0xSETTLEMENTBOBO");
store.llmCallRecord("evilagent", "claude-opus-5", 500, 120, 0, 0, "desk", 10_000n, "0xSETTLEMENTEVIL");

let bad = 0;
const check = (label: string, ok: boolean, note = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${note ? `  — ${note}` : ""}`);
};

// What the attacker can legitimately learn: the directory is public.
const roster = await get("/agents");
const target = roster.body.agents.find((a: any) => a.name === "bobo");
check("the directory does publish the handle and its owner", Boolean(target?.owner), target?.owner);

const PRIVATE = ["/chat/history?handle=bobo", "/rules?handle=bobo", "/triggers?handle=bobo", "/inference/mine?days=30"];

for (const path of PRIVATE) {
  const open = await get(path);
  check(`${path.split("?")[0]} refuses a stranger with no proof`, open.status === 403, open.body.error);
}

// The old attack, exactly: the owner address copied off the public page.
for (const path of PRIVATE) {
  const spoofed = await get(`${path}&owner=${target.owner}`);
  check(`${path.split("?")[0]} refuses the owner address alone`, spoofed.status === 403, spoofed.body.error);
}

// A real grant, but the attacker's own.
const theirs = await grantFor(attacker);
for (const path of PRIVATE.filter((p) => p.includes("handle="))) {
  const wrong = await get(path, theirs);
  check(`${path.split("?")[0]} refuses another operator's valid grant`, wrong.status === 404 || wrong.status === 403, wrong.body.error);
}

// A bill is scoped rather than refused: the attacker's own grant is valid, and
// the right answer is their own empty bill — never a row belonging to somebody
// else. This is the failure that would matter most, so it is asserted on the
// body rather than on the status code.
{
  const wrong = await get("/inference/mine?days=30", theirs);
  const names = JSON.stringify(wrong.body.byAgent ?? []) + JSON.stringify(wrong.body.thoughts ?? []);
  check(
    "/inference/mine shows another operator none of the victim's agents",
    wrong.status === 200 && !names.includes("bobo"),
    names.slice(0, 80),
  );
}

// A forged signature, and an expired one.
const forged = { ...(await grantFor(victim)), "x-smiths-signature": `0x${"11".repeat(65)}` };
check("a forged signature is refused", (await get(PRIVATE[0], forged)).status === 403);
const stale = await grantFor(victim, Date.now() - 1000);
check("an expired grant is refused", (await get(PRIVATE[0], stale)).status === 403);

// And the operator themselves still gets in.
const mine = await grantFor(victim);
const chat = await get(PRIVATE[0], mine);
check("the operator reads their own conversation", chat.status === 200 && chat.body.messages.length === 2,
  chat.body.messages?.[0]?.content?.slice(0, 40));
const rules = await get(PRIVATE[1], mine);
check("and their own rules", rules.status === 200 && rules.body.rules.length === 1, rules.body.rules?.[0]?.text);
const trg = await get(PRIVATE[2], mine);
check("and who their agent follows", trg.status === 200 && trg.body.triggers.length === 1);
const bill = await get("/inference/mine?days=30", mine);
check(
  "and their own bill for thinking",
  bill.status === 200 && bill.body.byAgent.some((a: any) => a.handle === "bobo"),
  JSON.stringify(bill.body.total ?? {}),
);

// Nothing secret leaked into the public surfaces along the way.
const publicText = JSON.stringify(roster.body) + JSON.stringify((await get("/runs?limit=50")).body) +
  JSON.stringify((await get("/events?limit=50")).body) + JSON.stringify((await get("/agents/bobo")).body);
check("no secret appears anywhere public", !/SECRET/.test(publicText));

server.kill("SIGTERM");
console.log(bad === 0 ? "\nPRIVATE IS PRIVATE" : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
