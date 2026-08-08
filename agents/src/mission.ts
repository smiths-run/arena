/**
 * Mission Control: the operator's panel.
 *
 *   npm run mission        # http://127.0.0.1:42072
 *
 * Binds to loopback only and must never be exposed: this is the surface that
 * pauses agents and triggers runs. It shares the sqlite ledger with the
 * orchestrator (WAL, so cross-process reads and writes are safe) and never
 * touches the chain or Circle — everything shown is the worker's own record,
 * which keeps the panel working even when the network is not.
 *
 * Controls are writes to the control tables, not signals to a process: a pause
 * survives an orchestrator restart, and a "run now" queued while the
 * orchestrator is down executes when it comes back.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fullRoster } from "./roster.ts";
import * as store from "./store.ts";

const PORT = Number(process.env.MISSION_PORT ?? 42072);
const HOST = "127.0.0.1";

/** The orchestrator stamps every 10s; three misses reads as offline. */
const OFFLINE_AFTER_MS = 35_000;

const agentNames = (): Set<string> => new Set(fullRoster().map((a) => a.name));

function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function state(): unknown {
  const now = Date.now();
  const beat = store.lastHeartbeatAt();
  const held = new Set(store.unresolvedPending().map((r) => r.agent));
  const net = store.netResultByAgent();

  const agents = fullRoster().map((a) => {
    const s = a.strategy;
    const lastRun = store.db
      .prepare("SELECT id, outcome, action_kind, reason, finished_at FROM runs WHERE agent = ? ORDER BY id DESC LIMIT 1")
      .get(a.name) as
      | { id: number; outcome: string | null; action_kind: string | null; reason: string | null; finished_at: number | null }
      | undefined;
    const sinceMs = now - store.lastRunAt(a.name);
    return {
      name: a.name,
      address: a.address,
      paused: store.isPaused(a.name),
      held: held.has(a.name),
      runRequested: store.hasPendingRunRequest(a.name),
      cooldownSeconds: s.cooldownSeconds,
      nextRunInSeconds: Math.max(0, Math.ceil((s.cooldownSeconds * 1000 - sinceMs) / 1000)),
      spent24h: store.spentLast24h(a.name).toString(),
      dailyCap: s.dailySpendUsdc.toString(),
      positions: store.positionsOf(a.name).length,
      net: net.find((n) => n.agent === a.name)?.net ?? "0",
      runs: net.find((n) => n.agent === a.name)?.runs ?? 0,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            outcome: lastRun.outcome,
            actionKind: lastRun.action_kind,
            reason: (lastRun.reason ?? "").split("\n")[0].slice(0, 120),
            finishedAt: lastRun.finished_at,
          }
        : null,
    };
  });

  const recent = (store.recentRuns(15) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id,
    agent: r.agent,
    trigger: r.trigger_kind,
    outcome: r.outcome,
    actionKind: r.action_kind,
    reason: String(r.reason ?? "").split("\n")[0].slice(0, 120),
    finishedAt: r.finished_at,
  }));

  return {
    orchestrator: { online: beat > 0 && now - beat < OFFLINE_AFTER_MS, lastBeatMsAgo: beat > 0 ? now - beat : null },
    agents,
    recent,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (req.method === "GET" && url.pathname === "/api/state") return json(res, state());

  if (req.method === "POST" && (url.pathname === "/api/pause" || url.pathname === "/api/run")) {
    const b = await body(req);
    const agent = String(b.agent ?? "");
    if (!agentNames().has(agent)) return json(res, { error: `unknown agent ${agent}` }, 400);
    if (url.pathname === "/api/pause") {
      store.setPaused(agent, Boolean(b.paused));
    } else {
      store.requestRun(agent);
    }
    return json(res, { ok: true });
  }

  json(res, { error: "not found" }, 404);
});

const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smiths Run — Mission Control</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0c0d10; color: #e6e6e6; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 28px 32px 60px; }
  h1 { font-size: 16px; font-weight: 600; letter-spacing: .04em; margin: 0 0 4px; }
  h1 small { color: #6b7280; font-weight: 400; }
  .beat { color: #6b7280; margin-bottom: 24px; }
  .beat .on { color: #34d399; }
  .beat .off { color: #f87171; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .card { background: #131519; border: 1px solid #23262d; border-radius: 10px; padding: 16px 18px; }
  .card.paused { border-color: #7c5c1e; }
  .card h2 { font-size: 14px; margin: 0 0 2px; display: flex; justify-content: space-between; align-items: baseline; }
  .addr { color: #4b5563; font-size: 11px; word-break: break-all; margin-bottom: 10px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 14px; font-size: 12.5px; color: #9ca3af; }
  .kv b { color: #e6e6e6; font-weight: 500; text-align: right; }
  .pos { color: #34d399; } .neg { color: #f87171; }
  .tag { font-size: 11px; padding: 1px 7px; border-radius: 99px; border: 1px solid #374151; color: #9ca3af; }
  .tag.warn { border-color: #7c5c1e; color: #fbbf24; }
  .tag.held { border-color: #7f1d1d; color: #f87171; }
  .last { margin-top: 10px; padding-top: 10px; border-top: 1px solid #1c1f26; font-size: 12px; color: #9ca3af; }
  .btns { margin-top: 12px; display: flex; gap: 8px; }
  button { background: #1c1f26; color: #e6e6e6; border: 1px solid #2d3139; border-radius: 7px; padding: 6px 14px; font: inherit; font-size: 12.5px; cursor: pointer; }
  button:hover { border-color: #4b5563; }
  button.primary { background: #16321f; border-color: #1e4d2b; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; color: #6b7280; font-weight: 500; padding: 6px 10px; border-bottom: 1px solid #23262d; }
  td { padding: 6px 10px; border-bottom: 1px solid #16181d; color: #9ca3af; }
  td.o-acted { color: #34d399; } td.o-skipped { color: #9ca3af; } td.o-rejected { color: #fbbf24; } td.o-error { color: #f87171; }
</style>
<h1>MISSION CONTROL <small>— smiths run, operator only</small></h1>
<div class="beat" id="beat">…</div>
<div class="grid" id="agents"></div>
<h1 style="margin-bottom:10px">RECENT RUNS</h1>
<table><thead><tr><th>#</th><th>agent</th><th>trigger</th><th>outcome</th><th>action</th><th>reason</th></tr></thead><tbody id="runs"></tbody></table>
<script>
const usdc = (v) => (Number(v) / 1e6).toFixed(3);
async function post(path, payload) {
  await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  refresh();
}
async function refresh() {
  const s = await (await fetch("/api/state")).json();
  const b = document.getElementById("beat");
  b.innerHTML = s.orchestrator.online
    ? 'orchestrator <span class="on">online</span> — last pass ' + Math.round(s.orchestrator.lastBeatMsAgo / 1000) + 's ago'
    : 'orchestrator <span class="off">offline</span>' + (s.orchestrator.lastBeatMsAgo ? " — last seen " + Math.round(s.orchestrator.lastBeatMsAgo / 1000) + "s ago" : " — never seen") + '; controls queue until it returns';
  document.getElementById("agents").innerHTML = s.agents.map((a) => {
    const tags = [
      a.held ? '<span class="tag held">tx in flight</span>' : "",
      a.paused ? '<span class="tag warn">paused</span>' : "",
      a.runRequested ? '<span class="tag">run queued</span>' : "",
    ].join(" ");
    const net = Number(a.net);
    return '<div class="card' + (a.paused ? " paused" : "") + '">'
      + '<h2>' + a.name + '<span>' + tags + '</span></h2>'
      + '<div class="addr">' + a.address + '</div>'
      + '<div class="kv">'
      + '<span>net result</span><b class="' + (net >= 0 ? "pos" : "neg") + '">' + (net >= 0 ? "+" : "") + usdc(a.net) + ' USDC</b>'
      + '<span>runs</span><b>' + a.runs + '</b>'
      + '<span>spent 24h</span><b>' + usdc(a.spent24h) + ' / ' + usdc(a.dailyCap) + '</b>'
      + '<span>positions</span><b>' + a.positions + '</b>'
      + '<span>next run</span><b>' + (a.paused ? "—" : a.nextRunInSeconds + "s") + '</b>'
      + '</div>'
      + (a.lastRun ? '<div class="last">#' + a.lastRun.id + " " + a.lastRun.outcome + (a.lastRun.actionKind ? " (" + a.lastRun.actionKind + ")" : "") + " — " + a.lastRun.reason + '</div>' : "")
      + '<div class="btns">'
      + '<button onclick=\\'post("/api/pause", {agent: "' + a.name + '", paused: ' + !a.paused + '})\\'>' + (a.paused ? "resume" : "pause") + '</button>'
      + '<button class="primary" onclick=\\'post("/api/run", {agent: "' + a.name + '"})\\'>run now</button>'
      + '</div></div>';
  }).join("");
  document.getElementById("runs").innerHTML = s.recent.map((r) =>
    '<tr><td>' + r.id + '</td><td>' + r.agent + '</td><td>' + r.trigger + '</td>'
    + '<td class="o-' + r.outcome + '">' + r.outcome + '</td><td>' + (r.actionKind ?? "") + '</td><td>' + r.reason + '</td></tr>'
  ).join("");
}
refresh();
setInterval(refresh, 3000);
</script>`;

server.listen(PORT, HOST, () => {
  console.log(`mission control on http://${HOST}:${PORT} — loopback only, do not expose`);
});
